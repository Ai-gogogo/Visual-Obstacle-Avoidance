import { VoiceControl } from "./VoiceControl";
import { QuickActions } from "./QuickActions";
import { VoiceSettings } from "./VoiceSettings";
import { QuestionInput } from "./QuestionInput";
import { SavedMemory } from "./SavedMemory";
import { ReplyPreferences } from "./ReplyPreferences";
import { Conversation } from "./Conversation";

export function AssistantPanel() {
  return (
    <section id="assist" data-page hidden>
      <div className="page-head">
        <div>
          <h1 tabIndex={-1}>Voice assistant</h1>
          <p>Talk to VisionAssist and follow along in the conversation.</p>
        </div>
        <span className="status" id="assist-mode">
          Local assistant
        </span>
      </div>
      <div className="assist-grid">
        <section className="voice-card" aria-labelledby="voice-title">
          <VoiceControl />
          <p className="active-options" id="active-options">
            Left camera (A) · System language
          </p>
          <QuickActions />
          <VoiceSettings />
          <QuestionInput />
          <SavedMemory />
          <ReplyPreferences />
        </section>
        <Conversation />
      </div>
    </section>
  );
}
