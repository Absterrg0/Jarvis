import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export type CirceTabId = "home" | "tasks" | "library";

const TABS: ReadonlyArray<{
  id: CirceTabId;
  label: string;
  icon: "house" | "list.bullet" | "book.closed";
}> = [
  { id: "home", label: "Home", icon: "house" },
  { id: "tasks", label: "Tasks", icon: "list.bullet" },
  { id: "library", label: "Library", icon: "book.closed" },
];

/**
 * Bottom tab bar matching the Circe reference: warm paper bar with a hairline
 * top border, copper active state, muted inactive state. Library opens the
 * archived-threads sheet; it never owns a stack route so it never stays
 * selected after the sheet dismisses.
 */
export function CirceTabBar({ selected }: { readonly selected: CirceTabId }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View
      accessibilityRole="tablist"
      className="flex-row border-t border-circe-tabbar-border bg-circe-tabbar"
      style={{ paddingBottom: Math.max(insets.bottom, 12), paddingTop: 8 }}
    >
      {TABS.map((tab) => {
        const active = selected === tab.id;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.label}
            onPress={() => {
              if (tab.id === "home") navigation.navigate("Circe");
              else if (tab.id === "tasks") navigation.navigate("Home");
              else
                navigation.navigate("SettingsSheet", {
                  screen: "SettingsContent",
                  params: { screen: "SettingsArchive" },
                });
            }}
            className="flex-1 items-center justify-center gap-1 py-1 active:opacity-70"
          >
            <SymbolView
              name={tab.icon}
              size={22}
              tintColorClassName={active ? "accent-circe-copper" : "accent-icon-muted"}
            />
            <Text
              className={`text-2xs font-t3-bold ${active ? "text-circe-copper" : "text-foreground-muted"}`}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
