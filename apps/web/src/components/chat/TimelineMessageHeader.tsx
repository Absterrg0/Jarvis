import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import { CirceMark } from "../circe/CirceLogo";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function HeaderTimestamp({
  value,
  timestampFormat,
}: {
  value: string;
  timestampFormat: TimestampFormat;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="text-muted-foreground text-xs tabular-nums" />}>
        {formatDayAwareTimestamp(value, timestampFormat)}
      </TooltipTrigger>
      <TooltipPopup>{formatChatTimestampTooltip(value, timestampFormat)}</TooltipPopup>
    </Tooltip>
  );
}

export function UserMessageHeader({
  createdAt,
  timestampFormat,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
}) {
  return (
    <div className="flex w-full max-w-[80%] items-center justify-end gap-1.5 pe-1">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
          <circle cx="6" cy="4" r="2.25" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M2.2 10.4c.6-1.7 2.1-2.6 3.8-2.6s3.2.9 3.8 2.6"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.3"
          />
        </svg>
      </span>
      <span className="text-xs font-medium text-muted-foreground">You</span>
      <HeaderTimestamp value={createdAt} timestampFormat={timestampFormat} />
    </div>
  );
}

export function AssistantMessageHeader({
  createdAt,
  timestampFormat,
}: {
  createdAt: string;
  timestampFormat: TimestampFormat;
}) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1.5">
      <CirceMark className="size-6 rounded-full" alt="" />
      <span className="text-xs font-medium text-foreground">Circe</span>
      <HeaderTimestamp value={createdAt} timestampFormat={timestampFormat} />
    </div>
  );
}
