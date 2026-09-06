import { useNavigation } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";

export function JarvisNavigation({ selected }: { readonly selected: "assistant" | "tasks" }) {
  const navigation = useNavigation();
  return (
    <View className="flex-row rounded-2xl bg-subtle p-1" accessibilityRole="tablist">
      {(["assistant", "tasks"] as const).map((tab) => (
        <Pressable
          key={tab}
          accessibilityRole="tab"
          accessibilityState={{ selected: selected === tab }}
          onPress={() => navigation.navigate(tab === "assistant" ? "Jarvis" : "Home")}
          className={`min-h-11 flex-1 items-center justify-center rounded-xl active:opacity-70 ${selected === tab ? "bg-card" : ""}`}
        >
          <Text
            className={`text-sm font-t3-bold ${selected === tab ? "text-foreground" : "text-foreground-muted"}`}
          >
            {tab === "assistant" ? "Assistant" : "Tasks"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
