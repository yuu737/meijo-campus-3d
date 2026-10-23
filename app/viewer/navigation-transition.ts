/** Only the latest navigation intent may change the camera or show an error. */
export class NavigationTransition {
  private sequence = 0;
  private retryAction: (() => void) | null = null;
  pending = false;
  error = '';
  message = '';
  constructor(private changed: () => void) {}
  cancel() {
    this.sequence++;
    this.pending = false;
    this.error = this.message = '';
    this.retryAction = null;
    this.changed();
  }
  async run<T>(prepare: () => Promise<T>, commit: (value:T) => void, message: string) {
    const request = ++this.sequence;
    this.pending = true;
    this.error = '';
    this.message = message;
    this.retryAction = null;
    this.changed();
    try {
      const value = await prepare();
      if (request !== this.sequence) return;
      this.pending = false;
      this.message = '';
      commit(value);
    } catch (error) {
      if (request !== this.sequence) return;
      this.pending = false;
      this.error = error instanceof Error ? error.message : '移動先を読み込めませんでした';
      this.retryAction = () => { void this.run(prepare, commit, message); };
    }
    if (request === this.sequence) this.changed();
  }
  retry() { this.retryAction?.(); }
}
