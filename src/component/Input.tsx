import { Description, Input as HeroInput, Label, TextField } from "@heroui/react";

type InputProps = {
  label: string;
  value: string;
  placeholder: string;
  type?: "text" | "password" | "number";
  onChange: (value: string) => void;
  disabled?: boolean;
  description?: string;
  className?: string;
};

export default function Input({ label, value, placeholder, type = "text", onChange, disabled, description, className }: InputProps) {
  return <TextField className={`app-field ${className ?? ""}`} value={value} onChange={onChange} type={type} isDisabled={disabled}>
    <Label>{label}</Label>
    <HeroInput placeholder={placeholder} autoComplete={type === "password" ? "off" : undefined} />
    {description && <Description>{description}</Description>}
  </TextField>;
}
