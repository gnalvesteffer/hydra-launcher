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

// Virtual cursor speed (pixels per frame at full deflection)
const CURSOR_SPEED = 18;

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

function scrollActiveContainerH(amount: number) {
  let el: HTMLElement | null = document.activeElement as HTMLElement | null;
  while (el && el !== document.body) {
    const overflow = window.getComputedStyle(el).overflowX;
    if (
      (overflow === "auto" || overflow === "scroll") &&
      el.scrollWidth > el.clientWidth
    ) {
      el.scrollBy({ left: amount, behavior: "smooth" });
      return;
    }
    el = el.parentElement;
  }
  window.scrollBy({ left: amount, behavior: "smooth" });
}

// ── Virtual cursor helpers ──────────────────────────────────────────────────

function createCursorEl(): HTMLElement {
  const el = document.createElement("div");
  el.id = "gamepad-cursor";
  el.style.cssText = [
    "position:fixed",
    "z-index:99999",
    "pointer-events:none",
    "width:20px",
    "height:20px",
    "border-radius:50%",
    "background:rgba(255,255,255,0.85)",
    "box-shadow:0 0 6px 2px rgba(0,0,0,0.6)",
    "transform:translate(-50%,-50%)",
    "transition:opacity 0.15s",
    "opacity:0",
    "left:50%",
    "top:50%",
  ].join(";");
  return el;
}

function dispatchMouseEvent(type: string, x: number, y: number) {
  const target = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!target) return;
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
    })
  );
}

export function useGamepadNavigation() {
  const buttonStates = useRef<Map<string, ButtonState>>(new Map());
  const animFrameRef = useRef<number | null>(null);
  const gamepadNavigationActive = useRef(false);
  const cursorPos = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const cursorEl = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handleGamepadConnected = (e: GamepadEvent) => {
      gamepadNavigationActive.current = true;
      document.body.setAttribute("data-gamepad", "true");
      logger.info(`[gamepad] connected: ${e.gamepad.id} (index ${e.gamepad.index}) mapping=${e.gamepad.mapping} axes=${e.gamepad.axes.length}`);
    };

    const handleGamepadDisconnected = (e: GamepadEvent) => {
      // Clear state for the disconnected controller
      const prefix = `${e.gamepad.index}_`;
      for (const key of buttonStates.current.keys()) {
        if (key.startsWith(prefix)) buttonStates.current.delete(key);
      }
      // Only disable navigation mode if no other gamepads remain
      if (navigator.getGamepads().every((g) => g === null)) {
        gamepadNavigationActive.current = false;
        document.body.removeAttribute("data-gamepad");
      }
    };

    window.addEventListener("gamepadconnected", handleGamepadConnected);
    window.addEventListener("gamepaddisconnected", handleGamepadDisconnected);

    // Create virtual cursor element
    const cursor = createCursorEl();
    document.body.appendChild(cursor);
    cursorEl.current = cursor;

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

      // Accumulators reset each frame — aggregates input from all controllers
      let totalRx = 0;
      let totalRy = 0;
      let rtFired = false;
      let ltFired = false;

      for (const gamepad of navigator.getGamepads()) {
        if (!gamepad) continue;

        // Process buttons — keyed by gamepadIndex_buttonIndex so multiple
        // controllers don't overwrite each other's state.
        gamepad.buttons.forEach((button, index) => {
          const key = `${gamepad.index}_${index}`;
          const prev = buttonStates.current.get(key);

          if (button.pressed) {
            if (!prev || !prev.pressed) {
              // First press
              buttonStates.current.set(key, {
                pressed: true,
                firstPressAt: now,
                lastRepeatAt: now,
              });
              logger.info(`[gamepad] button pressed: gp=${gamepad.index} btn=${index}`);
              handleButtonAction(index, true);
            }
          } else if (prev?.pressed) {
            buttonStates.current.set(key, {
              pressed: false,
              firstPressAt: 0,
              lastRepeatAt: 0,
            });
          }
        });

        // Left stick for scrolling (axes 0=LX, 1=LY)
        const lx = gamepad.axes[0] ?? 0;
        const ly = gamepad.axes[1] ?? 0;

        // Right stick axes depend on mapping:
        //   "standard" (Xbox/DS4 in browser standard mode): RX=axes[2], RY=axes[3]
        //   non-standard (Steam Deck, many Linux HID): triggers on axes[2]/[3], RX=axes[4], RY=axes[5]
        const isStandard = gamepad.mapping === "standard";
        const rx = isStandard ? (gamepad.axes[2] ?? 0) : (gamepad.axes[3] ?? 0);
        const ry = isStandard ? (gamepad.axes[3] ?? 0) : (gamepad.axes[4] ?? 0);

        // DEBUG: log all axes every ~120 frames so we can identify the right-stick axis indices
        if (Math.floor(now / 2000) !== Math.floor((now - 16) / 2000)) {
          logger.info(`[gamepad] idx=${gamepad.index} mapping=${gamepad.mapping} axes=[${Array.from(gamepad.axes).map((v) => v.toFixed(2)).join(",")}]`);
        }

        // Left stick vertical → vertical scroll
        if (Math.abs(ly) > STICK_DEAD_ZONE) {
          const stickKeyY = `${gamepad.index}_100`;
          const prevY = buttonStates.current.get(stickKeyY);
          const directionY = ly > 0 ? "down" : "up";
          if (!prevY?.pressed) {
            buttonStates.current.set(stickKeyY, { pressed: true, firstPressAt: now, lastRepeatAt: now });
            scrollActiveContainer(directionY);
          } else if (shouldRepeat(prevY, now)) {
            prevY.lastRepeatAt = now;
            scrollActiveContainer(directionY);
          }
        } else {
          buttonStates.current.delete(`${gamepad.index}_100`);
        }

        // Left stick horizontal → horizontal scroll
        if (Math.abs(lx) > STICK_DEAD_ZONE) {
          const stickKeyX = `${gamepad.index}_102`;
          const prevX = buttonStates.current.get(stickKeyX);
          const scrollAmountX = lx * 120;
          if (!prevX?.pressed) {
            buttonStates.current.set(stickKeyX, { pressed: true, firstPressAt: now, lastRepeatAt: now });
            scrollActiveContainerH(scrollAmountX);
          } else if (shouldRepeat(prevX, now)) {
            prevX.lastRepeatAt = now;
            scrollActiveContainerH(scrollAmountX);
          }
        } else {
          buttonStates.current.delete(`${gamepad.index}_102`);
        }

        // Accumulate right stick delta — applied after all controllers processed
        if (Math.abs(rx) > STICK_DEAD_ZONE) totalRx += rx;
        if (Math.abs(ry) > STICK_DEAD_ZONE) totalRy += ry;

        // RT (button 7) = left click — use value>0.1 for analog triggers
        const rtKey = `${gamepad.index}_rt`;
        const rtButton = gamepad.buttons[BUTTON.RT];
        const rtActive = (rtButton?.value ?? 0) > 0.1 || rtButton?.pressed;
        const rtWasPressed = buttonStates.current.get(rtKey)?.pressed ?? false;
        if (rtActive && !rtWasPressed) {
          buttonStates.current.set(rtKey, { pressed: true, firstPressAt: now, lastRepeatAt: now });
          rtFired = true;
        } else if (!rtActive && rtWasPressed) {
          buttonStates.current.set(rtKey, { pressed: false, firstPressAt: 0, lastRepeatAt: 0 });
        }

        // LT (button 6) = right click
        const ltKey = `${gamepad.index}_lt`;
        const ltButton = gamepad.buttons[BUTTON.LT];
        const ltActive = (ltButton?.value ?? 0) > 0.1 || ltButton?.pressed;
        const ltWasPressed = buttonStates.current.get(ltKey)?.pressed ?? false;
        if (ltActive && !ltWasPressed) {
          buttonStates.current.set(ltKey, { pressed: true, firstPressAt: now, lastRepeatAt: now });
          ltFired = true;
        } else if (!ltActive && ltWasPressed) {
          buttonStates.current.set(ltKey, { pressed: false, firstPressAt: 0, lastRepeatAt: 0 });
        }
      }

      // Apply accumulated right-stick cursor movement from ALL controllers
      if ((totalRx !== 0 || totalRy !== 0) && cursorEl.current) {
        const pos = cursorPos.current;
        pos.x = Math.max(0, Math.min(window.innerWidth,  pos.x + totalRx * CURSOR_SPEED));
        pos.y = Math.max(0, Math.min(window.innerHeight, pos.y + totalRy * CURSOR_SPEED));
        cursorEl.current.style.left = `${pos.x}px`;
        cursorEl.current.style.top  = `${pos.y}px`;
        cursorEl.current.style.opacity = "1";
        dispatchMouseEvent("mousemove", pos.x, pos.y);
      } else if (cursorEl.current) {
        cursorEl.current.style.opacity = "0";
      }

      // RT = left click
      if (rtFired) {
        const { x, y } = cursorPos.current;
        dispatchMouseEvent("mousedown", x, y);
        dispatchMouseEvent("mouseup",   x, y);
        dispatchMouseEvent("click",     x, y);
      }

      // LT = right click (contextmenu)
      if (ltFired) {
        const { x, y } = cursorPos.current;
        dispatchMouseEvent("contextmenu", x, y);
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
      cursorEl.current?.remove();
      cursorEl.current = null;
    };
  }, []);
}