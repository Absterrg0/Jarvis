export function releaseMobileAudioPlayer(player: { readonly pause: () => void }): void {
  player.pause();
}
