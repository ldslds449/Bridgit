import styled from "styled-components";

const StyledToast = styled.div<{ $hidden?: boolean; }>`
    visibility: ${props => props.$hidden ? "hidden" : "visible"};
    background-color: rgb(231, 231, 231);
    color: #000000;
    text-align: center;
    border-radius: 2px;
    padding: 16px;
    position: fixed;
    z-index: 1;
    left: 50%;
    bottom: 30px;
    transform: translate(-50%, -50%);

    @media(prefers-color-scheme: dark) {
        background-color: rgb(100, 100, 100);
        color: #ffffff;
    }
`;

type ToastProps = {
    hidden: boolean;
    message: string;
}

export default function Toast({ hidden, message }: ToastProps) {
    return (
        <StyledToast $hidden={hidden}>{message}</StyledToast>
    );
}