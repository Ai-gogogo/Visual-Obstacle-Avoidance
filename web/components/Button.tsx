import type { ComponentPropsWithoutRef } from "react";

type Props = ComponentPropsWithoutRef<"button"> & {
  variant?: "primary" | "quiet";
};

export function Button({
  variant = "quiet",
  className,
  type = "button",
  ...props
}: Props) {
  return (
    <button
      type={type}
      className={className ? `${variant} ${className}` : variant}
      {...props}
    />
  );
}
