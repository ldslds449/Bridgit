import { Button as HeroButton } from "@heroui/react";
import type { ReactNode } from "react";

type ButtonProps = {
  text: string;
  disable?: boolean;
  danger?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "tertiary" | "ghost" | "outline";
  icon?: ReactNode;
  className?: string;
};

export default function Button({ text, disable, danger, onClick, type = "button", variant = "secondary", icon, className }: ButtonProps) {
  return <HeroButton type={type} isDisabled={disable} onPress={onClick} variant={danger ? "danger-soft" : variant} className={className}>
    {icon}{text}
  </HeroButton>;
}
