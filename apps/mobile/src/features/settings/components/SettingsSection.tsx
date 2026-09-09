import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title: string;
  readonly children: ReactNode;
  /** Force the grouped card background; Android otherwise lists options flat. */
  readonly card?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="px-2 font-mono text-3xs font-t3-bold uppercase tracking-[1.1px] text-foreground-muted">
        {props.title}
      </Text>
      <View
        className={
          props.card
            ? "overflow-hidden rounded border border-border bg-card"
            : "overflow-hidden rounded border border-border bg-card android:border-transparent android:bg-transparent"
        }
      >
        {props.children}
      </View>
    </View>
  );
}
