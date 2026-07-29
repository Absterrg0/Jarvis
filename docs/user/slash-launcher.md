# Slash launcher and message queue

Type `/` in the chat composer to open the launcher. It searches across available models, provider skills, provider commands, and your custom commands.

Choose a model to switch the next turn to that provider and model. Choosing a skill inserts the provider's skill token into the prompt. Choosing a custom command expands its saved workflow prompt so you can review it before sending.

Choose **/new-command** in the launcher to create a command, or manage existing commands in **Settings → Commands**. When you save, the server's configured low-effort text-generation model refines the description and workflow prompt while preserving the command name. If that model is unavailable, the original workflow is saved unchanged. Names become `/name` entries in the launcher and are stored locally on the device.

While an agent is running, type a follow-up and choose **Queue**. Queued messages are sent in order when the active turn finishes. The composer shows the pending queue; use the remove button beside an entry to cancel it before it runs, or **Clear queue** to discard that thread's remaining messages.
