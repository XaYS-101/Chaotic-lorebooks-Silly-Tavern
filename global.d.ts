export {};
// Автокомплит для SillyTavern.getContext() и libs.
// Пути считаются от third-party/<Ext>/ — при необходимости поправь глубину.
import '../../../../public/global';

declare global {
  interface Window {
    chaoticLorebooks_interceptor: (
      chat: any[], contextSize: number, abort: (v?: boolean) => void, type: string
    ) => Promise<void>;
    world_names?: string[];
    SlashCommandParser?: any;
    SlashCommand?: any;
  }
}
