import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import SourceIcon from "./SourceIcon";

/** A screen: one inset panel with its title, a short line under it, actions on the right, and everything else inside. */
export function Page({ title, description, meta, actions, children }: { title: string; description?: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <VStack gap={6}>
        <VStack gap={2}>
          <HStack gap={4} justify="between" align="center" wrap="wrap">
            <Heading level={1}>{title}</Heading>
            {actions && <HStack gap={2} align="center" wrap="wrap">{actions}</HStack>}
          </HStack>
          {description && <Text as="p" type="supporting">{description}</Text>}
          {meta && <HStack gap={4} align="center" wrap="wrap" className="page-meta">{meta}</HStack>}
        </VStack>
        {children}
      </VStack>
    </div>
  );
}

/** A section card inside a page: title, count and status on the left, its actions on the right. */
export function Tile({ icon, title, count, status, actions, children }: {
  icon?: string; title: string; count?: number; status?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <Card variant="muted" padding={5} height="100%" className="tile">
      <VStack gap={3} height="100%">
        <HStack gap={3} align="center" justify="between">
          <HStack gap={2} align="center" wrap="wrap">
            {icon && <SourceIcon source={icon} size={18} />}
            <Heading level={3} accessibilityLevel={2}>{title}</Heading>
            {count !== undefined && <Text type="supporting" size="sm" hasTabularNumbers>{count.toLocaleString()}</Text>}
            {status}
          </HStack>
          {actions && <HStack gap={1} align="center">{actions}</HStack>}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}

/** A layer over the page for one task: details, a reply, a fix. */
export function Modal({ isOpen, onClose, title, subtitle, footer, width = 560, purpose, children }: {
  isOpen: boolean; onClose: () => void; title: string; subtitle?: ReactNode; footer?: ReactNode; width?: number; purpose?: "info" | "form"; children: ReactNode;
}) {
  const change = (open: boolean) => { if (!open) onClose(); };
  // Most modals unmount on close; give focus back to whatever opened them.
  // Read during the first render, before the dialog moves focus inside itself.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    if (!isOpen) return;
    return () => { if (opener instanceof HTMLElement && opener.isConnected) requestAnimationFrame(() => opener.focus()); };
  }, [isOpen, opener]);
  return (
    <Dialog isOpen={isOpen} onOpenChange={change} width={width} purpose={purpose} maxHeight="85dvh">
      <Layout
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={change} hasDivider={false} />}
        content={<LayoutContent isScrollable><VStack gap={4}>{children}</VStack></LayoutContent>}
        footer={footer && <LayoutFooter><HStack gap={2} justify="end" width="100%" wrap="wrap">{footer}</HStack></LayoutFooter>} />
    </Dialog>
  );
}

/** A big number with its label. */
export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <VStack gap={1}>
      <Text type="supporting" size="sm">{label}</Text>
      <Text type="display-3" hasTabularNumbers>{value}</Text>
    </VStack>
  );
}
