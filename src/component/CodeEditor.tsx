import { Label, TextArea, TextField } from "@heroui/react";
import { FileCode2 } from "lucide-react";

export default function CodeEditor({ label, value, onChange, disabled = false, compact = false }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean; compact?: boolean;
}) {
  return <div className="code-editor">
    <div className="editor-chrome"><span><FileCode2 size={15} />{label}</span><span>{value ? value.split("\n").length : 0} lines · SSH</span></div>
    <TextField value={value} onChange={onChange} isDisabled={disabled}>
      <Label className="sr-only">{label}</Label>
      <TextArea spellCheck={false} rows={compact ? 9 : 19} className="code-input" />
    </TextField>
  </div>;
}
