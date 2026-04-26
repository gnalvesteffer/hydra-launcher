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

// ---------- DEBUG OVERLAY ----------
function getOrCreateDebugOverlay(): HTMLElement {
  let el = document.getElementById("__gamepad_debug__");
  if (!el) {
    el = document.createElement("div");
    el.id = "__gamepad_debug__";
    el.style.cssText = [
      "position:fixed",
      "bottom:10px",
      "left:10px",
      "background:rgba(0,0,0,0.85)",
      "color:#0f0",
      "font:13px monospace",
      "padding:8px 12px",
      "border-radius:6px",
      "z-index:999999",
      "pointer-events:none",
      "white-space:pre",
      "line-height:1.5",
    ].join(";");
    document.documentElement.appendChild(el);
  }
  return el;
}
let _dbgLastBtn = "none";
let _dbgVisible = true;
function updateDebugOverlay(gamepad: Gamepad) {
  const el = getOrCreateDebugOverlay();
  el.style.display = _dbgVisible ? "block" : "none";
  if (!_dbgVisible) return;
  const axes = Array.from(gamepad.axes).map((v, i) => `a${i}:${v.toFixed(2)}`).join("  ");
  const btns = Array.from(gamepad.buttons)
    .map((b, i) => (b.pressed || b.value > 0.05 ? `[${i}:${b.value.toFixed(2)}]` : null))
    .filter(Boolean)
    .join(" ");
  el.textContent = `GP${gamepad.index} map=${gamepad.mapping}\nAxes: ${axes}\nActive btns: ${btns || "none"}\nLast pressed: ${_dbgLastBtn}`;
}
// ---------- END DEBUG OVERLAY ----------

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

function scrollFromPoint(x: number, y: number, deltaX: number, deltaY: number) {
  // Walk up from the element under the cursor to find a scrollable ancestor
  let el: HTMLElement | null = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && el !== document.body) {
    const style = window.getComputedStyle(el);
    const canScrollY = deltaY !== 0 && (style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight;
    const canScrollX = deltaX !== 0 && (style.overflowX === "auto" || style.overflowX === "scroll") && el.scrollWidth > el.clientWidth;
    if (canScrollY || canScrollX) {
      el.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
      return;
    }
    el = el.parentElement;
  }
  window.scrollBy({ left: deltaX, top: deltaY, behavior: "smooth" });
}

// ── Virtual cursor helpers ──────────────────────────────────────────────────

function createCursorEl(): HTMLElement {
  const el = document.createElement("div");
  el.id = "gamepad-cursor";
  el.style.cssText = [
    "position:fixed",
    "z-index:2147483647",
    "pointer-events:none",
    "width:20px",
    "height:20px",
    "border-radius:50%",
    "background:rgba(255,255,255,0.85)",
    "box-shadow:0 0 6px 2px rgba(0,0,0,0.6)",
    "transform:translate(-50%,-50%)",
    "transition:opacity 0.15s",
    "opacity:1",
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
  const lastInputSource = useRef<"gamepad" | "mouse">("mouse");

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

    // Override html overflow:hidden so position:fixed cursor isn't clipped
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'visible';

    // Create virtual cursor element
    const cursor = createCursorEl();
    document.documentElement.appendChild(cursor);
    cursorEl.current = cursor;

    // Hide virtual cursor when real mouse is used
    function onMouseMove() {
      lastInputSource.current = "mouse";
      if (cursorEl.current) cursorEl.current.style.opacity = "0";
    }


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
        case 6:
          if (isFirstPress) _dbgVisible = !_dbgVisible;
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
      let anyGamepadActive = false;
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
              _dbgLastBtn = `btn${index} (gp${gamepad.index})`;
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
        // axes[2]=LT, axes[5]=RT (triggers), so right stick is always axes[3]=RX, axes[4]=RY
        const isStandard = gamepad.mapping === "standard";
        const rx = gamepad.axes[3] ?? 0;
        const ry = gamepad.axes[4] ?? 0;

        // DEBUG: log all axes every ~120 frames so we can identify the right-stick axis indices
        if (Math.floor(now / 2000) !== Math.floor((now - 16) / 2000)) {
          logger.info(`[gamepad] idx=${gamepad.index} mapping=${gamepad.mapping} axes=[${Array.from(gamepad.axes).map((v) => v.toFixed(2)).join(",")}]`);
        }

        // Left stick → scroll from cursor position
        if (Math.abs(lx) > STICK_DEAD_ZONE || Math.abs(ly) > STICK_DEAD_ZONE) {
          const stickKey = `${gamepad.index}_100`;
          const prevStick = buttonStates.current.get(stickKey);
          if (!prevStick?.pressed) {
            buttonStates.current.set(stickKey, { pressed: true, firstPressAt: now, lastRepeatAt: now });
            scrollFromPoint(cursorPos.current.x, cursorPos.current.y, lx * 120, ly * 120);
          } else if (shouldRepeat(prevStick, now)) {
            prevStick.lastRepeatAt = now;
            scrollFromPoint(cursorPos.current.x, cursorPos.current.y, lx * 120, ly * 120);
          }
        } else {
          buttonStates.current.delete(`${gamepad.index}_100`);
        }

        // Accumulate right stick delta — applied after all controllers processed
        if (Math.abs(rx) > STICK_DEAD_ZONE) totalRx += rx;
        if (Math.abs(ry) > STICK_DEAD_ZONE) totalRy += ry;

        // RT = left click  (axes[5]: idle=-1, pressed=+1, threshold > 0)
        // LT = right click (axes[2]: idle=-1, pressed=+1, threshold > 0)
        const rtAxisVal = gamepad.axes[5] ?? -1;
        const ltAxisVal = gamepad.axes[2] ?? -1;
        const rtActive = rtAxisVal > 0;
        const ltActive = ltAxisVal > 0;

        const rtKey = `${gamepad.index}_rt`;
        const rtWasPressed = buttonStates.current.get(rtKey)?.pressed ?? false;
        if (rtActive && !rtWasPressed) {
          buttonStates.current.set(rtKey, { pressed: true, firstPressAt: now, lastRepeatAt: now });
          rtFired = true;
        } else if (!rtActive && rtWasPressed) {
          buttonStates.current.set(rtKey, { pressed: false, firstPressAt: 0, lastRepeatAt: 0 });
        }

        const ltKey = `${gamepad.index}_lt`;
        const ltWasPressed = buttonStates.current.get(ltKey)?.pressed ?? false;
        if (ltActive && !ltWasPressed) {
          buttonStates.current.set(ltKey, { pressed: true, firstPressAt: now, lastRepeatAt: now });
          ltFired = true;
        } else if (!ltActive && ltWasPressed) {
          buttonStates.current.set(ltKey, { pressed: false, firstPressAt: 0, lastRepeatAt: 0 });
        }
        // Mark gamepad active this frame if any button pressed or trigger pulled
        const anyBtn = gamepad.buttons.some(b => b.pressed || b.value > 0.05);
        if (anyBtn || rtActive || ltActive) anyGamepadActive = true;
        updateDebugOverlay(gamepad);
      }

      // Track last input source — also consider stick movement
      if (anyGamepadActive || totalRx !== 0 || totalRy !== 0) lastInputSource.current = "gamepad";

      // Apply accumulated right-stick cursor movement from ALL controllers
      if ((totalRx !== 0 || totalRy !== 0) && cursorEl.current) {
        const pos = cursorPos.current;
        pos.x = Math.max(0, Math.min(window.innerWidth,  pos.x + totalRx * CURSOR_SPEED));
        pos.y = Math.max(0, Math.min(window.innerHeight, pos.y + totalRy * CURSOR_SPEED));
        cursorEl.current.style.left = `${pos.x}px`;
        cursorEl.current.style.top  = `${pos.y}px`;

        dispatchMouseEvent("mousemove", pos.x, pos.y);
      } else if (cursorEl.current) {
        // Keep cursor visible if gamepad was the last input source

      }

      // RT = left click
      if (rtFired) {
        const { x, y } = cursorPos.current;
        dispatchMouseEvent("mousedown", x, y);
        dispatchMouseEvent("mouseup",   x, y);
        dispatchMouseEvent("click",     x, y);
        // Also focus input/textarea elements so the keyboard activates
        const rtTarget = document.elementFromPoint(x, y) as HTMLElement | null;
        if (rtTarget) {
          const focusable = rtTarget.closest("input, textarea, [contenteditable]") as HTMLElement | null;
          if (focusable) focusable.focus();
        }
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

      document.documentElement.style.overflow = prevHtmlOverflow;
      cursorEl.current?.remove();
      cursorEl.current = null;
    };
  }, []);
}