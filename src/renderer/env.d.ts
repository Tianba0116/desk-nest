import type { BubbleBridge } from '../shared/contracts/bubble-ipc';
import type { ChatBridge } from '../shared/contracts/chat';
import type { NestBridge } from '../shared/contracts/nest-ipc';
import type { PetBridge } from '../shared/contracts/pet-ipc';

declare global {
  interface Window {
    /** 宠物窗口（pet.html）才有 */
    petBridge: PetBridge;
    /** 小窝窗口（home.html）才有 */
    nest: NestBridge;
    /** 提醒气泡（bubble.html）才有 */
    bubble: BubbleBridge;
    /** 对话窗口（chat.html）才有 */
    chat: ChatBridge;
  }
}

export {};
