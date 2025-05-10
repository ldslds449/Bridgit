import styled from "styled-components";

const StyledToast = styled.div<{ $hidden?: boolean; }>`
    visibility: ${props => props.$hidden ? "hidden" : "visible"};
    background-color: #333;
    color: #fff;
    text-align: center;
    border-radius: 2px;
    padding: 16px;
    position: fixed;
    z-index: 1;
    left: 50%;
    bottom: 30px;
    transform: translate(-50%, -50%);
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