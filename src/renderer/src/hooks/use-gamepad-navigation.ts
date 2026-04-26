import { useEffect, useRef } from "react";
import { logger } from "@renderer/logger";

// Standard gamepad button indices (Xbox / Steam Deck layout)
const BUTTON = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  GUIDE: 16,
} as const;

// How long (ms) to wait before repeating while a button is held
const INITIAL_REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 120;

// Analogue stick dead-zone
const STICK_DEAD_ZONE = 0.35;

type ButtonState = {
  pressed: boolean;
  firstPressAt: number;
  lastRepeatAt: number;
};

function getFocusableElements(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => {
    const style = window.getComputedStyle(el);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.offsetParent !== null
    );
  });
}

function moveFocus(direction: "forward" | "backward") {
  const elements = getFocusableElements();
  if (elements.length === 0) return;

  const active = document.activeElement as HTMLElement | null;
  const currentIndex = active ? elements.indexOf(active) : -1;

  let nextIndex: number;
  if (direction === "forward") {
    nextIndex = currentIndex < elements.length - 1 ? currentIndex + 1 : 0;
  } else {
    nextIndex = currentIndex > 0 ? currentIndex - 1 : elements.length - 1;
  }

  elements[nextIndex]?.focus();
}

function pressEnter() {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return;

  // For inputs / textareas let the game pad not trigger click
  const tag = active.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;

  active.click();
}

function pressEscape() {
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Escape", bubbles: true })
  );
}

function focusSearch() {
  const search = document.querySelector<HTMLElement>(
    'input[type="search"], input[placeholder*="earch"], input[placeholder*="ilter"]'
  );
  search?.focus();
}

function scrollActiveContainer(direction: "up" | "down") {
  // Walk up the DOM from active element to find a scrollable ancestor
  let el: HTMLElement | null = document.activeElement as HTMLElement | null;
  while (el && el !== document.body) {
    const overflow = window.getComputedStyle(el).overflowY;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      el.scrollHeight > el.clientHeight
    ) {
      el.scrollBy({ top: direction === "down" ? 120 : -120, behavior: "smooth" });
      return;
    }
    el = el.parentElement;
  }
  // Fall back to window scroll
  window.scrollBy({ top: direction === "down" ? 120 : -120, behavior: "smooth" });
}

export function useGamepadNavigation() {
  const buttonStates = useRef<Map<number, ButtonState>>(new Map());
  const animFrameRef = useRef<number | null>(null);
  const gamepadNavigationActive = useRef(false);

  useEffect(() => {
    const handleGamepadConnected = (e: GamepadEvent) => {
      gamepadNavigationActive.current = true;
      document.body.setAttribute("data-gamepad", "true");
      logger.info(`[gamepad] connected: ${e.gamepad.id}`);
    };

    const handleGamepadDisconnected = () => {
      // Only disable if no other gamepads are connected
      if (navigator.getGamepads().every((g) => g === null)) {
        gamepadNavigationActive.current = false;
        document.body.removeAttribute("data-gamepad");
      }
    };

    window.addEventListener("gamepadconnected", handleGamepadConnected);
    window.addEventListener("gamepaddisconnected", handleGamepadDisconnected);

    // On first mount check if a gamepad is already connected (e.g. page reload)
    const gamepads = navigator.getGamepads();
    if (gamepads.some((g) => g !== null)) {
      gamepadNavigationActive.current = true;
      document.body.setAttribute("data-gamepad", "true");
    }

    function shouldRepeat(state: ButtonState, now: number): boolean {
      if (!state.pressed) return false;
      if (now - state.firstPressAt < INITIAL_REPEAT_DELAY) return false;
      return now - state.lastRepeatAt >= REPEAT_INTERVAL;
    }

    function handleButtonAction(buttonIndex: number, isFirstPress: boolean) {
      switch (buttonIndex) {
        case BUTTON.DPAD_DOWN:
          moveFocus("forward");
          break;
        case BUTTON.DPAD_UP:
          moveFocus("backward");
          break;
        case BUTTON.DPAD_RIGHT:
          // Horizontal movement: also forward in tab order
          moveFocus("forward");
          break;
        case BUTTON.DPAD_LEFT:
          moveFocus("backward");
          break;
        case BUTTON.A:
          if (isFirstPress) pressEnter();
          break;
        case BUTTON.B:
          if (isFirstPress) pressEscape();
          break;
        case BUTTON.Y:
          if (isFirstPress) focusSearch();
          break;
        case BUTTON.LB:
          if (isFirstPress) {
            // Navigate to previous sidebar route via keyboard shortcut simulation
            document.dispatchEvent(
              new CustomEvent("gamepad:navigate-prev", { bubbles: true })
            );
          }
          break;
        case BUTTON.RB:
          if (isFirstPress) {
            document.dispatchEvent(
              new CustomEvent("gamepad:navigate-next", { bubbles: true })
            );
          }
          break;
        case BUTTON.START:
          if (isFirstPress) focusSearch();
          break;
        default:
          break;
      }
    }

    function pollGamepads() {
      const now = performance.now();

      for (const gamepad of navigator.getGamepads()) {
        if (!gamepad) continue;

        // Process buttons
        gamepad.buttons.forEach((button, index) => {
          const prev = buttonStates.current.get(index);

          if (button.pressed) {
            if (!prev || !prev.pressed) {
              // First press
              buttonStates.current.set(index, {
                pressed: true,
                firstPressAt: now,
                lastRepeatAt: now,
              });
              handleButtonAction(index, true);
            } else if (shouldRepeat(prev, now)) {
              // Auto-repeat for navigation buttons
              if (
                index === BUTTON.DPAD_UP ||
                index === BUTTON.DPAD_DOWN ||
                index === BUTTON.DPAD_LEFT ||
                index === BUTTON.DPAD_RIGHT
              ) {
                prev.lastRepeatAt = now;
                handleButtonAction(index, false);
              }
            }
          } else if (prev?.pressed) {
            buttonStates.current.set(index, {
              pressed: false,
              firstPressAt: 0,
              lastRepeatAt: 0,
            });
          }
        });

        // Left stick for scrolling (axes 0=LX, 1=LY)
        const lx = gamepad.axes[0] ?? 0;
        const ly = gamepad.axes[1] ?? 0;

        // Right stick for focus navigation (axes 2=RX, 3=RY)
        const ry = gamepad.axes[3] ?? 0;

        // Scroll with left stick vertical
        if (Math.abs(ly) > STICK_DEAD_ZONE) {
          const stickKey = 100; // virtual key for left stick Y
          const prev = buttonStates.current.get(stickKey);
          const direction = ly > 0 ? "down" : "up";

          if (!prev?.pressed) {
            buttonStates.current.set(stickKey, {
              pressed: true,
              firstPressAt: now,
              lastRepeatAt: now,
            });
            scrollActiveContainer(direction);
          } else if (shouldRepeat(prev, now)) {
            prev.lastRepeatAt = now;
            scrollActiveContainer(direction);
          }
        } else {
          buttonStates.current.delete(100);
        }

        // Focus navigation with right stick vertical
        if (Math.abs(ry) > STICK_DEAD_ZONE) {
          const stickKey = 101;
          const prev = buttonStates.current.get(stickKey);
          const direction = ry > 0 ? "forward" : "backward";

          if (!prev?.pressed) {
            buttonStates.current.set(stickKey, {
              pressed: true,
              firstPressAt: now,
              lastRepeatAt: now,
            });
            moveFocus(direction);
          } else if (shouldRepeat(prev, now)) {
            prev.lastRepeatAt = now;
            moveFocus(direction);
          }
        } else {
          buttonStates.current.delete(101);
        }

        // Ignore left stick X (lx) for now — could be used for sidebar later
        void lx;
      }

      animFrameRef.current = requestAnimationFrame(pollGamepads);
    }

    animFrameRef.current = requestAnimationFrame(pollGamepads);

    return () => {
      window.removeEventListener("gamepadconnected", handleGamepadConnected);
      window.removeEventListener(
        "gamepaddisconnected",
        handleGamepadDisconnected
      );
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);
}
