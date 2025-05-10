import styled from "styled-components";

const StyledButton = styled.button<{ $danger?: boolean; }>`
    border-radius: 8px;
    border: 1px solid transparent;
    padding: 0.6em 1.2em;
    font-size: 1em;
    font-weight: 500;
    font-family: inherit;
    transition: border-color 0.25s;
    cursor: pointer;
    outline: none;
    color: rgb(15, 15, 15);
    box-shadow: 0 2px 2px rgba(0, 0, 0, 0.2);

    background-color:${({ $danger }) => { return $danger ? 'rgb(255, 129, 129)' : 'rgb(255, 255, 255)' }};

    &:hover {
        border-color: #396cd8;
    }

    &:active {
        border-color: #396cd8;
        background-color: ${({ $danger }) => { return $danger ? 'rgb(236, 104, 104)' : 'rgb(232, 232, 232)' }};
    }

    &:disabled {
        background-color: rgb(226, 226, 226);
        cursor: not-allowed;
    }

@media(prefers-color-scheme: dark) {
    color: #ffffff;
    background-color:${({ $danger }) => { return $danger ? 'rgb(235, 99, 99)' : 'rgba(15, 15, 15, 0.6);' }};
    
    &:active {
        background-color: ${({ $danger }) => { return $danger ? 'rgb(214, 75, 75)' : 'rgba(15, 15, 15, 0.41)' }};
    }
    
    &:disabled {
        background-color: rgb(87, 87, 87);
        cursor: not-allowed;
    }
}
`;

type ButtonProps = {
    text: string;
    disable?: boolean;
    danger?: boolean;
    onClick?: () => void;
}

export default function Button({ text, disable, danger, onClick }: ButtonProps) {
    return (
        <StyledButton type="submit" disabled={disable} onClick={onClick} $danger={danger}>{text}</StyledButton>
    );
}