"use client";

import { Button, Dialog, Portal } from "@chakra-ui/react";

interface AlertDialogProps {
  open: boolean;
  title: string;
  description: string;
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function AlertDialog({
  open,
  title,
  description,
  cancelLabel = "Cancel",
  confirmLabel = "Confirm",
  destructive = false,
  onCancel,
  onConfirm,
}: AlertDialogProps) {
  return (
    <Dialog.Root
      open={open}
      role="alertdialog"
      placement="center"
      size="xs"
      onOpenChange={(e) => {
        if (!e.open) onCancel();
      }}
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(9,9,11,.5)" backdropFilter="blur(3px)" />
        <Dialog.Positioner>
          <Dialog.Content
            maxW="400px"
            bg="surface"
            borderWidth="1px"
            borderColor="border"
            borderRadius="14px"
            boxShadow="0 20px 50px -12px rgba(0,0,0,.35)"
          >
            <Dialog.Header pt="24px" px="24px" pb="8px">
              <Dialog.Title fontSize="17px" fontWeight="600" letterSpacing="-.01em" color="fg">
                {title}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px="24px" pt="0" pb="22px">
              <Dialog.Description fontSize="14px" lineHeight="1.5" color="fgMuted">
                {description}
              </Dialog.Description>
            </Dialog.Body>
            <Dialog.Footer px="24px" pt="0" pb="20px" gap="10px">
              <Dialog.ActionTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  borderColor="border"
                  borderRadius="control"
                  fontSize="13.5px"
                  fontWeight="500"
                >
                  {cancelLabel}
                </Button>
              </Dialog.ActionTrigger>
              <Button
                size="sm"
                colorPalette={destructive ? "red" : "accent"}
                borderRadius="control"
                fontSize="13.5px"
                fontWeight="500"
                onClick={onConfirm}
              >
                {confirmLabel}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
