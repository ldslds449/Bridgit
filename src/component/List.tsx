import styled from "styled-components";

const StyledButton = styled.button`
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
    cursor: pointer;
    outline: none;

    &:hover {
        border-color: #396cd8;
    }

    &:active {
        border-color: #396cd8;
        background-color: #e8e8e8;
    }

    &:disabled {
        background-color:rgb(87, 87, 87);
        cursor: not-allowed;
    }


    @media (prefers-color-scheme: dark) {
        color: #ffffff;
        background-color: #0f0f0f98;
        &:active {
            background-color: #0f0f0f69;
        }
    }
`;

type ButtonProps = {
    text: string;
    disable: boolean;
    onClick?: () => void;
}

export default function Button({ text, disable, onClick }: ButtonProps) {
    return (
        <StyledButton type="submit" disabled={disable} onClick={onClick}>{text}</StyledButton>
    );
}