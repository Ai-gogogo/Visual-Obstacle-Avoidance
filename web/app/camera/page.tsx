import type { Metadata } from "next";
import { PhoneCamera } from "../../features/camera/PhoneCamera";

export const metadata: Metadata = {
  title: "VisionAssist Camera",
  description: "Pair a phone with the VisionAssist camera monitor.",
};

export default function CameraPage() {
  return <PhoneCamera />;
}
