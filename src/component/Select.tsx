import { Label, ListBox, Select as HeroSelect } from "@heroui/react";

export default function Select({ label, value, onChange, options, disabled }: {
  label: string; value: string; onChange: (value: string) => void;
  options: { id: string; label: string }[]; disabled?: boolean;
}) {
  return <HeroSelect className="app-field" value={value} onChange={key => { if (key !== null) onChange(String(key)); }} isDisabled={disabled}>
    <Label>{label}</Label>
    <HeroSelect.Trigger><HeroSelect.Value /><HeroSelect.Indicator /></HeroSelect.Trigger>
    <HeroSelect.Popover><ListBox>
      {options.map(option => <ListBox.Item key={option.id} id={option.id} textValue={option.label}>{option.label}<ListBox.ItemIndicator /></ListBox.Item>)}
    </ListBox></HeroSelect.Popover>
  </HeroSelect>;
}
