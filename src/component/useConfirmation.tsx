import { useEffect, useRef, useState } from "react";
import { Modal } from "@heroui/react";
import { RotateCcw, ShieldAlert } from "lucide-react";
import Button from "./Button";
import Input from "./Input";

type Confirmation = { title: string; description: string; details?: string; danger?: boolean; phrase?: string; confirmLabel?: string };

export function useConfirmation() {
  const [options, setOptions] = useState<Confirmation>();
  const [phrase, setPhrase] = useState("");
  const resolve = useRef<((answer: boolean) => void) | undefined>(undefined);
  useEffect(() => () => { resolve.current?.(false); }, []);

  function confirm(options: Confirmation) {
    resolve.current?.(false);
    setPhrase(""); setOptions(options);
    return new Promise<boolean>(done => { resolve.current = done; });
  }
  function close(answer: boolean) {
    resolve.current?.(answer); resolve.current = undefined; setOptions(undefined);
  }
  const dialog = <Modal.Backdrop isOpen={!!options} onOpenChange={open => { if (!open) close(false); }}>
    <Modal.Container size="md"><Modal.Dialog>
      <Modal.CloseTrigger />
      <Modal.Header><div className={`modal-symbol ${options?.danger ? "danger" : ""}`}>{options?.danger ? <ShieldAlert /> : <RotateCcw />}</div>
        <Modal.Heading>{options?.title}</Modal.Heading></Modal.Header>
      <Modal.Body><p className="muted">{options?.description}</p>
        {options?.details && <pre className="confirmation-details">{options.details}</pre>}
        {options?.phrase && <Input label={`輸入 ${options.phrase} 確認`} value={phrase} placeholder={options.phrase} onChange={setPhrase} />}
      </Modal.Body>
      <Modal.Footer><Button text="取消" variant="tertiary" onClick={() => close(false)} />
        <Button text={options?.confirmLabel ?? "確認"} danger={options?.danger} variant="primary" disable={!!options?.phrase && phrase !== options.phrase} onClick={() => close(true)} />
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop>;
  return { confirm, dialog };
}
