import { useId } from "react";
import { CheckIcon } from "@primer/octicons-react";
import "./checkbox-field.scss";

export interface CheckboxFieldProps
  extends React.DetailedHTMLProps<
    React.InputHTMLAttributes<HTMLInputElement>,
    HTMLInputElement
  > {
  label: string | React.ReactNode;
  hint?: string;
}

export function CheckboxField({ label, hint, ...props }: CheckboxFieldProps) {
  const id = useId();

  return (
    <div className="checkbox-field">
      <div
        className={`checkbox-field__checkbox ${props.checked ? "checked" : ""}`}
      >
        <input
          id={id}
          type="checkbox"
          className="checkbox-field__input"
          {...props}
        />
        <span
          className={`checkbox-field__icon ${props.checked ? "checked" : ""}`}
        >
          <CheckIcon />
        </span>
      </div>
      <div className="checkbox-field__label-group">
        <label htmlFor={id} className="checkbox-field__label">
          {label}
        </label>
        {hint && <p className="checkbox-field__hint">{hint}</p>}
      </div>
    </div>
  );
}
