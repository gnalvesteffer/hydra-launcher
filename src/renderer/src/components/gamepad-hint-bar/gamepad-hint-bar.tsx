import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import "./gamepad-hint-bar.scss";

interface Hint {
  icon: string;
  labelKey: string;
}

const HINTS: Hint[] = [
  { icon: "⊕", labelKey: "confirm" },
  { icon: "⊗", labelKey: "back" },
  { icon: "LB RB", labelKey: "change_section" },
  { icon: "⊙", labelKey: "search" },
];

export function GamepadHintBar() {
  const { t } = useTranslation("gamepad_hint_bar");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setVisible(document.body.hasAttribute("data-gamepad"));
    });

    observer.observe(document.body, { attributes: true, attributeFilter: ["data-gamepad"] });

    // Sync initial state
    setVisible(document.body.hasAttribute("data-gamepad"));

    return () => observer.disconnect();
  }, []);

  if (!visible) return null;

  return (
    <div className="gamepad-hint-bar" aria-hidden="true">
      {HINTS.map((hint) => (
        <div key={hint.labelKey} className="gamepad-hint-bar__hint">
          <span className="gamepad-hint-bar__icon">{hint.icon}</span>
          <span className="gamepad-hint-bar__label">{t(hint.labelKey)}</span>
        </div>
      ))}
    </div>
  );
}
