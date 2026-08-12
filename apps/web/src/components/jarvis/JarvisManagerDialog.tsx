import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JarvisExecutionStarted,
  JarvisNeedsInput,
  ThreadId,
} from "@t3tools/contracts";
import { AudioLinesIcon, MicIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { JarvisAttentionTarget, JarvisCommandTarget } from "../../jarvisBus";
import { isPreferredJarvisSpeaker, setPreferredJarvisSpeaker } from "../../jarvisPreferences";
import { useProject } from "../../state/entities";
import { jarvisEnvironment } from "../../state/jarvis";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Field, FieldLabel } from "../ui/field";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import {
  appendJarvisChoice,
  applyJarvisClarificationChoice,
  jarvisErrorMessage,
  jarvisTaskStartedText,
} from "./JarvisManager.logic";

interface SpeechRecognitionResultEventLike {
  readonly results: ArrayLike<{
    readonly isFinal: boolean;
    readonly 0: { readonly transcript: string };
  }>;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function speechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  const browserWindow = window as typeof window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null;
}

interface JarvisManagerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef: React.RefObject<HTMLElement | null>;
  readonly attentionTarget: JarvisAttentionTarget | null;
  readonly routeTarget: JarvisCommandTarget | null;
  readonly onTargetConsumed: () => void;
  readonly onThreadStarted: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Promise<void> | void;
  readonly autoSubmitVoice?: boolean;
  readonly companionMode?: boolean;
  readonly initialUtterance?: string | null;
}

function speakTaskStarted(result: JarvisExecutionStarted): void {
  const text = jarvisTaskStartedText(result.modelSelection);
  if (window.jarvisCompanion?.speak) {
    void window.jarvisCompanion.speak(text);
    return;
  }
  if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = navigator.language || "en-US";
  window.speechSynthesis.speak(utterance);
}

export function JarvisManagerDialog({
  open,
  onOpenChange,
  returnFocusRef,
  attentionTarget,
  routeTarget,
  onTargetConsumed,
  onThreadStarted,
  autoSubmitVoice = false,
  companionMode = false,
  initialUtterance = null,
}: JarvisManagerDialogProps) {
  const executeInstruction = useAtomCommand(jarvisEnvironment.execute, {
    reportFailure: false,
    reportDefect: false,
  });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const [utterance, setUtterance] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [listening, setListening] = useState(false);
  const [clarification, setClarification] = useState<JarvisNeedsInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preferredSpeaker, setPreferredSpeakerState] = useState(isPreferredJarvisSpeaker);
  const submitVoiceTranscriptRef = useRef(false);
  const companionListeningStartedRef = useRef(false);

  const commandTarget: JarvisCommandTarget | null = attentionTarget
    ? {
        environmentId: attentionTarget.environmentId,
        projectId: attentionTarget.projectId,
        contextThreadId: attentionTarget.threadId,
        contextThreadTitle: attentionTarget.threadTitle,
      }
    : routeTarget;
  const targetProjectRef = useMemo(() => {
    return commandTarget
      ? scopeProjectRef(commandTarget.environmentId, commandTarget.projectId)
      : null;
  }, [commandTarget]);
  const activeProject = useProject(targetProjectRef);
  const target =
    commandTarget && activeProject
      ? {
          ...commandTarget,
          projectTitle: activeProject.title,
        }
      : null;
  const nativeSpeechAvailable =
    companionMode && window.jarvisCompanion?.recognizeSpeech !== undefined;
  const speechAvailable = nativeSpeechAvailable || speechRecognitionConstructor() !== null;

  /* eslint-disable unicorn/prefer-add-event-listener -- Web Speech uses nullable handler properties across Chromium versions. */
  const releaseRecognition = useCallback((abort: boolean) => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      if (abort) recognition.abort();
    }
    setListening(false);
  }, []);

  useEffect(() => () => releaseRecognition(true), [releaseRecognition]);

  useEffect(() => {
    if (!initialUtterance) return;
    setUtterance(initialUtterance);
    submitVoiceTranscriptRef.current = true;
  }, [initialUtterance]);

  const resetAndClose = useCallback(() => {
    releaseRecognition(true);
    setUtterance("");
    setClarification(null);
    setError(null);
    onOpenChange(false);
  }, [onOpenChange, releaseRecognition]);

  const toggleListening = useCallback(() => {
    if (nativeSpeechAvailable) {
      if (listening) return;
      setError(null);
      setListening(true);
      void window.jarvisCompanion
        ?.recognizeSpeech()
        .then((result) => {
          if (!result.ok) {
            setError(result.message);
            return;
          }
          setUtterance((current) => appendJarvisChoice(current, result.transcript));
          submitVoiceTranscriptRef.current = autoSubmitVoice;
        })
        .catch(() => setError("Windows speech recognition was unavailable. You can type instead."))
        .finally(() => {
          setListening(false);
          requestAnimationFrame(() => textareaRef.current?.focus());
        });
      return;
    }
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      releaseRecognition(false);
      return;
    }
    const Recognition = speechRecognitionConstructor();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result?.isFinal) continue;
        setUtterance((current) => appendJarvisChoice(current, result[0].transcript));
        submitVoiceTranscriptRef.current = autoSubmitVoice;
        break;
      }
      recognition.stop();
      releaseRecognition(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    recognition.onerror = () => {
      setError("Browser speech recognition stopped. You can continue by typing.");
      releaseRecognition(false);
    };
    recognition.onend = () => releaseRecognition(false);
    recognitionRef.current = recognition;
    setError(null);
    setListening(true);
    try {
      recognition.start();
    } catch (cause) {
      releaseRecognition(true);
      setError(jarvisErrorMessage(cause));
    }
  }, [autoSubmitVoice, listening, nativeSpeechAvailable, releaseRecognition]);
  /* eslint-enable unicorn/prefer-add-event-listener */

  useEffect(() => {
    if (!open) {
      companionListeningStartedRef.current = false;
      return;
    }
    if (
      !companionMode ||
      companionListeningStartedRef.current ||
      !target ||
      listening ||
      submitting ||
      utterance.trim().length > 0
    ) {
      return;
    }
    companionListeningStartedRef.current = true;
    const frame = requestAnimationFrame(toggleListening);
    return () => cancelAnimationFrame(frame);
  }, [companionMode, listening, open, submitting, target, toggleListening, utterance]);

  const submit = useCallback(async () => {
    const instruction = utterance.trim();
    if (!target || instruction.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    setClarification(null);
    const commandResult = await executeInstruction({
      environmentId: target.environmentId,
      input: {
        projectId: target.projectId,
        ...(target.contextThreadId ? { contextThreadId: target.contextThreadId } : {}),
        utterance: instruction,
      },
    });
    setSubmitting(false);
    if (commandResult._tag === "Failure") {
      setError(jarvisErrorMessage(squashAtomCommandFailure(commandResult)));
      return;
    }
    const result = commandResult.value;
    if (result.status === "needs-input") {
      setClarification(result);
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (companionMode) speakTaskStarted(result);
    setUtterance("");
    onTargetConsumed();
    onOpenChange(false);
    await onThreadStarted(target.environmentId, result.threadId);
  }, [
    executeInstruction,
    onOpenChange,
    onTargetConsumed,
    companionMode,
    onThreadStarted,
    submitting,
    target,
    utterance,
  ]);

  useEffect(() => {
    if (
      !autoSubmitVoice ||
      !submitVoiceTranscriptRef.current ||
      utterance.trim().length === 0 ||
      !target ||
      submitting
    ) {
      return;
    }
    submitVoiceTranscriptRef.current = false;
    void submit();
  }, [autoSubmitVoice, submit, submitting, utterance]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !submitting) resetAndClose();
      }}
    >
      <DialogPopup
        className="w-full max-w-xl overflow-hidden rounded-xl border-border/80 p-0"
        finalFocus={() => returnFocusRef.current ?? false}
        initialFocus={() => textareaRef.current}
      >
        <header className="border-b border-border/65 bg-muted/18 px-4 py-3.5 pr-11">
          <div className="flex min-w-0 items-center gap-3">
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-md border border-info/30 bg-info/8 text-info-foreground">
              <AudioLinesIcon className="size-3.5" />
              <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-info shadow-[0_0_0_2px_var(--popover)]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <DialogTitle className="shrink-0 font-mono text-sm font-semibold leading-5 tracking-tight">
                  JARVIS
                </DialogTitle>
                <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                  command relay
                </span>
              </div>
              <p className="mt-0.5 flex items-center gap-1.5 text-[11px] font-medium text-info-foreground">
                <span className="size-1 rounded-full bg-info" aria-hidden="true" />
                T3 is managing
              </p>
            </div>
            <div className="min-w-0 max-w-[45%] text-right font-mono text-[10px] uppercase tracking-[0.08em]">
              <p className="text-muted-foreground">Target</p>
              <p
                className={target ? "truncate text-foreground" : "text-warning-foreground"}
                title={target?.contextThreadTitle ?? target?.projectTitle}
              >
                {target?.contextThreadTitle ?? target?.projectTitle ?? "No project"}
              </p>
            </div>
          </div>
          <DialogDescription className="sr-only">
            Route an instruction to a provider and model through T3.
          </DialogDescription>
        </header>

        <DialogPanel className="space-y-3 p-4">
          <Field className="gap-1.5">
            <div className="flex w-full items-center justify-between gap-2">
              <FieldLabel
                htmlFor="jarvis-instruction"
                className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                Instruction
              </FieldLabel>
              <div className="flex items-center gap-1.5">
                <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
                  {navigator.platform.includes("Mac") ? "⌘" : "CTRL"}+ENTER TO RUN
                </span>
                {speechAvailable ? (
                  <Button
                    type="button"
                    variant={listening ? "secondary" : "ghost"}
                    size="icon-xs"
                    aria-label={
                      listening ? "Listening for your instruction" : "Speak an instruction"
                    }
                    aria-pressed={listening}
                    title={
                      listening
                        ? "Stop listening"
                        : nativeSpeechAvailable
                          ? "Speak your instruction. Jarvis will send it as soon as Windows recognizes it. Audio stays on this PC."
                          : "Speak your instruction. Jarvis starts the task after a final transcript. Audio processing depends on your browser and may use an online speech service."
                    }
                    onClick={toggleListening}
                    disabled={!target || submitting}
                  >
                    {listening ? <SquareIcon /> : <MicIcon />}
                  </Button>
                ) : null}
                <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
                  {speechAvailable
                    ? listening
                      ? "listening"
                      : autoSubmitVoice
                        ? "tap to speak"
                        : "browser voice"
                    : "text only"}
                </span>
              </div>
            </div>
            <Textarea
              id="jarvis-instruction"
              ref={textareaRef}
              value={utterance}
              onChange={(event) => {
                setUtterance(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="Use Codex Sol at high effort to review the current implementation…"
              disabled={!target || submitting}
              aria-invalid={error ? true : undefined}
              className="rounded-md border-border/85 bg-muted/12 font-mono shadow-inner shadow-black/3 before:rounded-[calc(var(--radius-md)-1px)] dark:bg-black/12"
            />
          </Field>

          {!target ? (
            <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-warning-foreground">
              Select a project thread to arm the relay
            </p>
          ) : null}

          {clarification ? (
            <section
              aria-live="polite"
              aria-labelledby="jarvis-clarification-title"
              className="rounded-md border border-info/20 bg-info/6 px-3 py-2.5"
            >
              <h3 id="jarvis-clarification-title" className="text-xs font-semibold">
                T3 needs one detail
              </h3>
              <p className="mt-1 text-sm text-foreground/88">{clarification.prompt}</p>
              {clarification.choices.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Available choices">
                  {clarification.choices.map((choice) => (
                    <Button
                      key={choice}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setUtterance((current) =>
                          applyJarvisClarificationChoice(current, clarification, choice),
                        );
                        setClarification(null);
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                    >
                      {choice}
                    </Button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/25 bg-destructive/8 px-3 py-2 text-sm dark:bg-destructive/12"
            >
              <p className="font-medium text-destructive-foreground">Couldn’t start the task</p>
              <p className="mt-0.5 text-xs text-destructive-foreground/78">{error}</p>
            </div>
          ) : null}
        </DialogPanel>

        <div className="flex items-center justify-between gap-3 border-t border-border/65 bg-muted/24 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              type="button"
              size="xs"
              variant={preferredSpeaker ? "secondary" : "ghost"}
              aria-pressed={preferredSpeaker}
              title="Prefer this device when several connected devices can speak a report"
              onClick={() => {
                const next = !preferredSpeaker;
                setPreferredJarvisSpeaker(next);
                setPreferredSpeakerState(next);
              }}
            >
              <AudioLinesIcon />
              {preferredSpeaker ? "Voice device" : "Prefer voice here"}
            </Button>
            <span className="hidden font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground sm:inline">
              {clarification ? "Awaiting input" : error ? "Relay fault" : "Relay ready"}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={!target || utterance.trim().length === 0 || submitting}
          >
            {submitting ? <Spinner /> : <PlayIcon />}
            {submitting ? "Routing…" : "Run"}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
