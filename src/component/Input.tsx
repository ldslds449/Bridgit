import styled from "styled-components";

const StyledLabel = styled.label`
    display: inline-block;
    padding: 10px;
    min-width: 100px;
`;

const StyledInput = styled.input`
    border-radius: 8px;
    border: 1px solid transparent;
    padding: 0.6em 1.2em;
    font-size: 1em;
    font-weight: 500;
    font-family: inherit;
    color: #0f0f0f;
    background-color: #ffffff;
    transition: border-color 0.25s;
    box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);
    outline: none;
    width: 150px;

    @media (prefers-color-scheme: dark) {
        color: #ffffff;
        background-color: #0f0f0f98;
    }
`;

type InputProps = {
    label: string;
    value: string;
    placeholder: string;
    type: string;
    onChange: (arg: string) => void;
}

export default function Input({ label, value, placeholder, type, onChange }: InputProps) {
    return (
        <div style={{ display: "inline-block" }}>
            <StyledLabel>{label}</StyledLabel>
            <StyledInput
                onChange={(e) => onChange(e.currentTarget.value)}
                placeholder={placeholder}
                value={value}
                type={type}
            />
        </div>
    );
}