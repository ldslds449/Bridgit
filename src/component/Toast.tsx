import { CircleAlert } from "lucide-react";

export default function Toast({ hidden, message }: { hidden: boolean; message: string }) {
  if (hidden) return null;
  return <div role="alert" className="app-toast"><CircleAlert size={18} /><span>{message}</span></div>;
}
