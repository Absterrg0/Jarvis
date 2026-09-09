import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly approval: PendingApproval;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly onRespond: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options = props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  // Opaque for the same reason as PendingUserInputCard: nothing blurs the feed
  // behind this card, so a translucent surface bleeds messages through it.
  // Chrome follows the theme tokens; the accept action uses the primary
  // amber and the eyebrow uses the mono warning voice shared with section
  // labels. Option buttons keep a 44pt minimum touch target.
  return (
    <View className="gap-2.5 rounded border border-border bg-card p-4">
      <Text className="font-mono text-3xs font-t3-bold uppercase tracking-[1.1px] text-warning">
        Approval needed
      </Text>
      <Text className="font-t3-bold text-lg text-foreground">
        {props.approval.appName ?? props.approval.requestKind}
      </Text>
      {props.approval.detail ? (
        <Text className="font-sans text-sm leading-normal text-foreground-secondary">
          {props.approval.detail}
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Pressable
            key={option.decision}
            className={`min-h-11 items-center justify-center rounded-[3px] px-3.5 py-3 ${
              option.decision === "accept"
                ? "bg-primary"
                : option.decision === "decline"
                  ? "bg-danger"
                  : "bg-subtle"
            }`}
            disabled={props.respondingApprovalId === props.approval.requestId}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          >
            <Text
              className={`text-sm ${
                option.decision === "accept"
                  ? "font-t3-extrabold text-primary-foreground"
                  : option.decision === "decline"
                    ? "font-t3-bold text-danger-foreground"
                    : "font-t3-bold text-foreground"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
