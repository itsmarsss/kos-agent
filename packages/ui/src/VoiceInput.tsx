import { useEffect, useRef, useState, type ReactElement } from "react";

/**
 * Dictating a message instead of typing it.
 *
 * Uses the browser's own speech recognition, which means nothing is sent
 * anywhere by KOS: the recognition happens where the page is, and the text
 * arrives in the composer as if it had been typed. There is no audio upload
 * and no key to configure, which is the right trade for a feature that is
 * convenience rather than capability.
 *
 * Not every browser has it. Where it is absent the button is simply not
 * rendered, because a button that explains why it cannot work is worse than no
 * button.
 */

/** The vendor-prefixed constructor, where the browser has one. */
function recognizer(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}

export function VoiceInput({
  onText,
  disabled,
}: {
  /** Called with each finished phrase, to be appended to the draft. */
  onText: (text: string) => void;
  disabled?: boolean;
}): ReactElement | null {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = useRef<SpeechRecognitionLike | null>(null);
  const supported = useRef(recognizer());

  useEffect(() => {
    return () => {
      // Stop the microphone if the composer goes away mid-phrase.
      engine.current?.stop();
      engine.current = null;
    };
  }, []);

  if (!supported.current) return null;

  const start = (): void => {
    const Engine = supported.current!;
    const it = new Engine();
    it.lang = navigator.language || "en-US";
    // Continuous, because dictating a paragraph should not need the button
    // pressed again after every sentence.
    it.continuous = true;
    it.interimResults = false;
    it.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) onText(result[0].transcript.trim());
      }
    };
    it.onerror = (e) => {
      // "no-speech" is a pause, not a fault, and saying so would be noise.
      if (e.error && e.error !== "no-speech" && e.error !== "aborted") {
        setError(
          e.error === "not-allowed"
            ? "Microphone permission was refused."
            : `Dictation stopped: ${e.error}`,
        );
      }
      setListening(false);
    };
    it.onend = () => setListening(false);
    engine.current = it;
    setError(null);
    setListening(true);
    it.start();
  };

  const stop = (): void => {
    engine.current?.stop();
    setListening(false);
  };

  return (
    <button
      type="button"
      className={`icon-btn ${listening ? "is-listening" : ""}`}
      disabled={disabled}
      aria-pressed={listening}
      title={error ?? (listening ? "Stop dictating" : "Dictate a message")}
      onClick={() => (listening ? stop() : start())}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        aria-hidden="true"
      >
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  );
}
