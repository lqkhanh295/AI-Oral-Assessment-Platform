"use client";
import Image from "next/image";
import { QuestionContent } from "./question-content";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CheckCircle2,
  Clock3,
  GraduationCap,
  Mic,
  LoaderCircle,
  Square,
  UploadCloud,
} from "lucide-react";
import {
  api,
  send,
  errorText,
  ExamSession,
  StudentExam,
  SpeechPolicy,
} from "./api";
import { Action, Badge, Empty } from "./shared";
import { DesktopPolicySummary } from "./desktop-policy";
import NoiseCheck from "./noise-check";
import { useQuestionTimer, type QuestionClock } from "./use-question-timer";
import { useExamGuard } from "./use-exam-guard";
import DesktopSpeechSettings, {
  useDesktopSpeech,
  DESKTOP_STT_MODEL,
  type DesktopModel,
} from "./desktop-speech-settings";
import { createNoiseFilter, type NoiseFilter } from "../lib/noise-filter";
import {
  savePendingAnswer,
  getPendingAnswer,
  deletePendingAnswer,
  saveUploadJob,
  updateUploadJobStatus,
  getUploadJobsForSession,
  deleteUploadJob,
  clearCompletedUploadJobs,
  clearSessionState,
} from "../lib/offlineStorage";
import DesktopDisplaySettings, {
  type DesktopDisplayStatus,
} from "./desktop-display-settings";
import {
  createMicrophoneGain,
  peakDbfs,
  type MicrophoneGain,
} from "../lib/microphone-gain";

type STT = {
  transcript: string;
  stt_confidence: number | null;
  stt_skipped_reason?: "MODEL_MISSING";
};
declare global {
  interface Window {
    oralDesktop?: {
      openGoogle?: (url: string) => Promise<void>;
      focus?: () => Promise<void>;
      settings?: () => Promise<void>;
      policyVersion?: number;
      beginExam?: (sessionId?: string) => Promise<void>;
      endExam?: (options?: { restoreDisplays?: boolean }) => Promise<void>;
      displayStatus?: () => Promise<DesktopDisplayStatus>;
      useSingleDisplay?: (keep: string) => Promise<DesktopDisplayStatus>;
      restoreDisplays?: () => Promise<DesktopDisplayStatus>;
      onExamEvent?: (callback: (type: string) => void) => () => void;
      quit?: () => Promise<void>;
      downloadModel?: (
        backendMode: "local" | "online",
      ) => Promise<{ ready: boolean }>;
      sttModels?: () => Promise<DesktopModel[]>;
      transcribe: (audio: ArrayBuffer, policy: SpeechPolicy) => Promise<STT>;
    };
  }
}
type PendingAnswer = {
  attemptId: string;
  audio: Blob;
  filteredAudio: Blob | null;
  sttSource: "original" | "filtered";
  transcript: string;
  confidence: number | null;
  sttSkippedReason?: "MODEL_MISSING";
  originalText: string;
  key: string;
};
type UploadJob = {
  id: string;
  attemptId: string;
  kind: "AUDIO" | "SCREEN";
  blob: Blob;
  progress: number;
  status: "pending" | "uploading" | "done" | "failed";
  error?: string;
};
const hash = async (blob: Blob) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
const audioMime = () =>
  ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );

function submissionBadge(status: string) {
  return ["SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(status)
    ? "RECEIVED"
    : status;
}

export default function Student() {
  const [cameraRatio, setCameraRatio] = useState(4 / 3);
  const [displayBusy, setDisplayBusy] = useState(false);
  const [screenConsent, setScreenConsent] = useState(false);
  const screenJobs = useRef(
    new Map<Blob, { job: UploadJob; task: Promise<boolean> }>(),
  );
  const desktopSpeech = useDesktopSpeech();
  const [courseFilter, setCourseFilter] = useState("");
  const [exams, setExams] = useState<StudentExam[]>([]),
    [session, setSession] = useState<ExamSession | null>(null),
    [error, setError] = useState("");
  const autoSubmitRecording = useRef(false);
  const answerUploads = useRef(new Map<string, UploadJob[]>());
  const cameraRequired = session?.desktop_policy?.require_camera ?? true;
  const timedQuestions = !!session?.timed_questions;
  const serverProcessing = !!session?.server_processing;
  const sessionFinished =
    !!session &&
    ["SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(session.status);
  const [stream, setStream] = useState<MediaStream | null>(null),
    [noiseReady, setNoiseReady] = useState(false),
    [micLevel, setMicLevel] = useState(0),
    [recording, setRecording] = useState(false),
    [processing, setProcessing] = useState(false),
    [submitting, setSubmitting] = useState(false),
    [speechStage, setSpeechStage] = useState("Đang tải cấu hình nhận dạng…");
  const [isOnline, setIsOnline] = useState(true);
  const [answer, setAnswer] = useState<PendingAnswer | null>(null),
    [jobs, setJobs] = useState<UploadJob[]>([]),
    [remaining, setRemaining] = useState(0),
    [deviceError, setDeviceError] = useState("");
  const [availableDevices, setAvailableDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [deviceListError, setDeviceListError] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [cameraId, setCameraId] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [startingRecording, setStartingRecording] = useState(false);
  const connectingRef = useRef(false);
  const [denoise, setDenoise] = useState(false);
  const [gainDb, setGainDb] = useState(0);
  const [micPeak, setMicPeak] = useState(-120);
  const gainRef = useRef<MicrophoneGain | null>(null);
  const [filterError, setFilterError] = useState("");
  const filterRef = useRef<NoiseFilter | null>(null);
  const filterFailures = useRef(0);
  const deviceGeneration = useRef(0);
  const preview = useRef<HTMLVideoElement>(null),
    recorders = useRef<MediaRecorder[]>([]),
    streamRef = useRef<MediaStream | null>(null);
  const stopRef = useRef<() => void>(() => {}),
    localDeadline = useRef<number | null>(null),
    recordingRef = useRef(false);
  const loadExams = useCallback(async () => {
    const rows = await api<StudentExam[]>("/exams/available");
    setExams(rows);
  }, []);
  const refreshSession = useCallback(async (id: string) => {
    const s = await api<ExamSession>(`/exam-sessions/${id}`);
    setSession(s);
    return s;
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsOnline(navigator.onLine);
    const onOnline = () => {
      setIsOnline(true);
      setJobs((all) => {
        all
          .filter((j) => j.status === "failed")
          .forEach((j) => void runUpload(j));
        return all;
      });
    };
    const onOffline = () => {
      setIsOnline(false);
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!session?.id) return;
    let cancelled = false;

    async function recoverOfflineData() {
      try {
        const storedJobs = await getUploadJobsForSession(session!.id);
        if (cancelled) return;
        const incomplete = storedJobs.filter((j) => j.status !== "done");
        if (incomplete.length > 0) {
          setJobs((current) => {
            const currentIds = new Set(current.map((j) => j.id));
            const newJobs: UploadJob[] = incomplete
              .filter((j) => !currentIds.has(j.id))
              .map((j) => ({
                id: j.id,
                attemptId: j.attemptId,
                kind: j.kind,
                blob: j.blob,
                progress: j.progress,
                status: j.status,
                error: j.error,
              }));
            if (newJobs.length > 0) {
              setTimeout(() => {
                newJobs.forEach((job) => void runUpload(job));
              }, 500);
            }
            return [...current, ...newJobs];
          });
        }

        if (session!.current_attempt?.id && !answer) {
          const storedAnswer = await getPendingAnswer(session!.current_attempt.id);
          if (cancelled || !storedAnswer) return;
          setAnswer({
            attemptId: storedAnswer.attemptId,
            audio: storedAnswer.audio,
            filteredAudio: storedAnswer.filteredAudio,
            sttSource: storedAnswer.sttSource,
            transcript: storedAnswer.transcript,
            originalText: storedAnswer.originalText,
            confidence: storedAnswer.confidence,
            sttSkippedReason: storedAnswer.sttSkippedReason,
            key: storedAnswer.key,
          });
        }
      } catch (err) {
        console.warn("[recovery] Could not recover offline data:", err);
      }
    }

    void recoverOfflineData();
    return () => {
      cancelled = true;
    };
  }, [session?.id, session?.current_attempt?.id]);

  const guard = useExamGuard(session, () => stopRef.current());
  function endAnswer() {
    autoSubmitRecording.current = timedQuestions;
    stopRef.current();
  }
  const questionTimer = useQuestionTimer({
    id: session?.current_attempt?.id,
    enabled: timedQuestions && session?.status === "IN_PROGRESS",
    canRecord:
      !!stream &&
      !deviceError &&
      !connecting &&
      !guard.blocked &&
      !guard.preparing &&
      !guard.finishing &&
      !startingRecording &&
      !processing &&
      !submitting,
    recording,
    hasAnswer: !!answer,
    start,
    end: endAnswer,
  });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- State updates follow an asynchronous API response.
    loadExams().catch((e) => setError(errorText(e)));
  }, [loadExams]);
  useEffect(() => {
    if (session?.started_at)
      localDeadline.current =
        Date.now() +
        (session.started_at + session.time_limit - session.server_time) * 1000;
  }, [session]);
  useEffect(() => {
    if (preview.current) preview.current.srcObject = stream;
  }, [stream, session?.status]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (localDeadline.current) {
        const left = Math.max(
          0,
          Math.ceil((localDeadline.current - Date.now()) / 1000),
        );
        setRemaining(left);
        if (!left && recordingRef.current) {
          autoSubmitRecording.current = timedQuestions;
          stopRef.current();
        }
      }
    }, 500);
    const before = (e: Event) => {
      if (
        recordingRef.current ||
        answer ||
        jobs.some((j) => j.status !== "done")
      )
        e.preventDefault();
    };
    window.addEventListener("beforeunload", before);
    window.addEventListener("oral:backend-switch", before);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", before);
      window.removeEventListener("oral:backend-switch", before);
    };
  }, [answer, jobs, timedQuestions]);
  useEffect(
    () => () => {
      for (const r of recorders.current) {
        r.onstop = null;
        r.onerror = null;
        if (r.state !== "inactive") r.stop();
      }
      deviceGeneration.current++;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void filterRef.current?.close();
      void gainRef.current?.close();
    },
    [],
  );
  useEffect(() => {
    if (
      !session ||
      !["SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(session.status)
    )
      return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    void filterRef.current?.close();
    filterRef.current = null;
    void gainRef.current?.close();
    gainRef.current = null;
  }, [session?.id, session?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!stream || sessionFinished) return;
    const context = new AudioContext(),
      analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context
      .createMediaStreamSource(gainRef.current?.stream || stream)
      .connect(analyser);
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const floats = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(samples);
      analyser.getFloatTimeDomainData(floats);
      setMicPeak(peakDbfs(floats));
      setMicLevel(
        Math.min(
          100,
          Math.sqrt(
            samples.reduce((s, x) => s + (x - 128) ** 2, 0) / samples.length,
          ) * 4,
        ),
      );
    }, 120);
    return () => {
      clearInterval(timer);
      void context.close();
    };
  }, [stream, sessionFinished]);
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let active = true;
    const refresh = async () => {
      try {
        const items = await media.enumerateDevices();
        if (active) {
          setAvailableDevices(
            items.filter(
              (d) => d.kind === "audioinput" || d.kind === "videoinput",
            ),
          );
          setDeviceListError("");
        }
      } catch {
        if (active)
          setDeviceListError(
            "Không đọc được danh sách thiết bị. Hãy cấp quyền camera/mic rồi thử lại.",
          );
      }
    };
    void refresh();
    media.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      media.removeEventListener("devicechange", refresh);
    };
  }, [stream]);

  async function devices(
    selectedMic = microphoneId,
    selectedCamera = cameraId,
  ) {
    if (
      connectingRef.current ||
      startingRecording ||
      recordingRef.current ||
      processing ||
      submitting
    )
      return;
    connectingRef.current = true;
    const generation = ++deviceGeneration.current;
    setConnecting(true);
    setDeviceError("");
    setFilterError("");
    setNoiseReady(false);
    setStream(null);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const oldFilter = filterRef.current;
    filterRef.current = null;
    const oldGain = gainRef.current;
    gainRef.current = null;
    try {
      await oldFilter?.close();
      await oldGain?.close();
      if (generation !== deviceGeneration.current) return;
      if (!navigator.mediaDevices || typeof MediaRecorder === "undefined")
        throw new Error(
          "Cần trình duyệt hỗ trợ MediaRecorder trên HTTPS hoặc localhost.",
        );
      const s = await navigator.mediaDevices.getUserMedia({
        video: cameraRequired
          ? {
              ...(selectedCamera
                ? { deviceId: { exact: selectedCamera } }
                : {}),
              width: { ideal: 640 },
              height: { ideal: 480 },
            }
          : false,
        audio: {
          ...(selectedMic ? { deviceId: { exact: selectedMic } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      if (generation !== deviceGeneration.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      // Desktop records the device tracks directly. Optional gain/RNNoise
      // processing belongs only to the browser exam flow.
      if (!window.oralDesktop) {
        let gain: MicrophoneGain;
        try {
          gain = await createMicrophoneGain(s, gainDb);
        } catch (error) {
          s.getTracks().forEach((t) => t.stop());
          throw error;
        }
        if (generation !== deviceGeneration.current) {
          await gain.close();
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        gainRef.current = gain;
        try {
          const filter = await createNoiseFilter(gain.stream, () => {
            if (generation === deviceGeneration.current) {
              filterFailures.current++;
              setFilterError(
                "RNNoise bị lỗi. Tắt lọc nhiễu hoặc kết nối lại mic trước khi ghi âm.",
              );
            }
          });
          if (generation !== deviceGeneration.current) {
            await filter.close();
            await gain.close();
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          // Browser retains a filtered alternative for STT retries.
          filter.setEnabled(true);
          filterRef.current = filter;
        } catch {
          if (generation !== deviceGeneration.current) {
            await gain.close();
            s.getTracks().forEach((t) => t.stop());
            return;
          }
          setFilterError(
            "Không tải được RNNoise. Tắt lọc nhiễu để thu bản gốc hoặc kết nối lại mic.",
          );
        }
      }
      s.getTracks().forEach((t) => {
        t.onended = () => {
          if (generation !== deviceGeneration.current) return;
          setDeviceError(
            "Thiết bị đã ngắt kết nối. Chọn thiết bị khác hoặc kết nối lại trước khi tiếp tục.",
          );
          setNoiseReady(false);
          if (recordingRef.current) stopRef.current();
        };
      });
      setMicrophoneId(
        s.getAudioTracks()[0]?.getSettings().deviceId || selectedMic,
      );
      setCameraId(
        s.getVideoTracks()[0]?.getSettings().deviceId || selectedCamera,
      );
      streamRef.current = s;
      setStream(s);
    } catch (error) {
      if (generation === deviceGeneration.current) {
        const name = error instanceof DOMException ? error.name : "";
        setDeviceError(
          name === "NotAllowedError"
            ? "Chưa được cấp quyền camera/mic. Cho phép quyền trong ứng dụng hoặc hệ điều hành rồi kết nối lại."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "Thiết bị đã chọn không còn khả dụng. Chọn thiết bị khác trong danh sách."
              : errorText(error),
        );
      }
    } finally {
      if (generation === deviceGeneration.current) setConnecting(false);
      connectingRef.current = false;
    }
  }
  async function transcribe(audio: Blob): Promise<STT> {
    if (window.oralDesktop) {
      setSpeechStage("Đang kiểm tra bộ nhận dạng trên máy…");
      const models = await desktopSpeech.inspect();
      const model = models.find((item) => item.id === DESKTOP_STT_MODEL);
      if (!model)
        throw new Error(
          "Không kiểm tra được Whisper-small. Mở lại desktop rồi thử lại.",
        );
      if (!model.available)
        return {
          transcript: "",
          stt_confidence: null,
          stt_skipped_reason: "MODEL_MISSING",
        };
    }
    setSpeechStage("Đang tải cấu hình nhận dạng…");
    const savedPolicy = await api<SpeechPolicy>(
      `/stt/config${session ? `?session_id=${encodeURIComponent(session.id)}` : ""}`,
    );
    // Desktop uses original audio locally. Browser filtering, when selected,
    // happens on the client; neither path needs server preprocessing.
    const policy: SpeechPolicy = {
      ...savedPolicy,
      provider: window.oralDesktop ? "local" : savedPolicy.provider,
      preprocessing: "off",
      ...(window.oralDesktop
        ? {
            language: desktopSpeech.preferences.language,
            desktop_model: DESKTOP_STT_MODEL,
          }
        : {}),
    };
    const providerLabel = {
      local: "Whisper trên máy của bạn",
      google: "Google Cloud STT",
      gemini: "Gemini",
      local_server: "Whisper trên server",
    }[policy.provider];
    const label = window.oralDesktop
      ? `Whisper-small · ${policy.language === "en" ? "Tiếng Anh" : "Tiếng Việt"}`
      : providerLabel;
    setSpeechStage(`Đang nhận dạng bằng ${label}. Vui lòng đợi…`);
    if (policy.provider === "local") {
      if (!window.oralDesktop)
        throw new Error(
          "Admin chọn STT local. Vui lòng dùng ứng dụng desktop để nhận dạng.",
        );
      return window.oralDesktop.transcribe(await audio.arrayBuffer(), policy);
    }
    const form = new FormData();
    form.set("file", audio, "answer.webm");
    form.set("preprocessing", "off");
    if (session) form.set("session_id", session.id);
    return api<STT>("/stt", { method: "POST", body: form });
  }
  async function start() {
    if (guard.blocked || guard.preparing || guard.finishing)
      throw new Error(
        "Khôi phục chế độ thi và ghi màn hình trước khi trả lời.",
      );
    if (!session?.current_attempt || !stream || deviceError || connecting)
      throw new Error("Kiểm tra camera và microphone trước.");
    const am = audioMime();
    if (!am)
      throw new Error(
        "Trình duyệt chưa hỗ trợ định dạng ghi âm. Dùng Chrome hoặc Electron.",
      );
    if (!window.oralDesktop && denoise && (!filterRef.current || filterError))
      throw new Error(
        "Lọc nhiễu chưa sẵn sàng. Tắt lọc nhiễu hoặc kết nối lại mic.",
      );
    const attemptId = session.current_attempt.id;
    const capture = new MediaStream([
      ...(window.oralDesktop
        ? stream
        : gainRef.current?.stream || stream
      ).getAudioTracks(),
    ]);
    const audioRecorder = new MediaRecorder(
      new MediaStream(capture.getAudioTracks()),
      { mimeType: am },
    );
    const filterVersion = filterFailures.current;
    const cleanRecorder =
      !window.oralDesktop && filterRef.current && !filterError
        ? new MediaRecorder(filterRef.current.stream, { mimeType: am })
        : null;
    const audioChunks: BlobPart[] = [],
      cleanChunks: BlobPart[] = [];
    if (cleanRecorder)
      cleanRecorder.ondataavailable = (e) => {
        if (e.data.size) cleanChunks.push(e.data);
      };
    audioRecorder.ondataavailable = (e) => {
      if (e.data.size) audioChunks.push(e.data);
    };
    const guardRevision = guard.getRevision();
    setStartingRecording(true);
    let timing: QuestionClock | undefined;
    try {
      timing = await send<QuestionClock>(
        `/question-attempts/${attemptId}/start`,
      );
      // A focus/display/capture interruption can arrive while the server
      // acknowledges this start. Never start recorders on a stale permission.
      guard.assertReady(guardRevision);
    } finally {
      setStartingRecording(false);
    }
    const activeRecorders = [
      audioRecorder,
      ...(cleanRecorder ? [cleanRecorder] : []),
    ];
    let stops = 0;
    const stopped = async () => {
      stops++;
      if (stops < activeRecorders.length) return;
      recordingRef.current = false;
      setRecording(false);
      setProcessing(true);
      const a: PendingAnswer = {
        attemptId,
        audio: new Blob(audioChunks, { type: am.split(";")[0] }),
        filteredAudio:
          cleanRecorder &&
          filterVersion === filterFailures.current &&
          cleanChunks.length
            ? new Blob(cleanChunks, { type: am.split(";")[0] })
            : null,
        sttSource: "original",
        transcript: "",
        originalText: "",
        confidence: 0,
        key: crypto.randomUUID(),
      };
      a.sttSource =
        !window.oralDesktop && denoise && a.filteredAudio
          ? "filtered"
          : "original";
      setAnswer(a);
      void savePendingAnswer({
        attemptId,
        sessionId: session?.id ?? "",
        audio: a.audio,
        filteredAudio: a.filteredAudio,
        sttSource: a.sttSource,
        transcript: a.transcript,
        confidence: a.confidence,
        sttSkippedReason: a.sttSkippedReason,
        originalText: a.originalText,
        key: a.key,
        savedAt: Date.now(),
      });
      if (serverProcessing) {
        setProcessing(false);
        setError("");
        if (autoSubmitRecording.current) {
          autoSubmitRecording.current = false;
          try {
            await submit(a, true);
          } catch (e) {
            setError(errorText(e));
          }
        }
        return;
      }
      try {
        const stt = await transcribe(
          a.sttSource === "filtered" ? a.filteredAudio! : a.audio,
        );
        a.transcript = stt.transcript;
        a.originalText = stt.transcript;
        a.confidence = stt.stt_confidence;
        a.sttSkippedReason = stt.stt_skipped_reason;
        setAnswer({ ...a });
        void savePendingAnswer({
          attemptId,
          sessionId: session?.id ?? "",
          audio: a.audio,
          filteredAudio: a.filteredAudio,
          sttSource: a.sttSource,
          transcript: a.transcript,
          confidence: a.confidence,
          sttSkippedReason: a.sttSkippedReason,
          originalText: a.originalText,
          key: a.key,
          savedAt: Date.now(),
        });
      } catch (e) {
        setError(
          `${errorText(e)} ${window.oralDesktop ? "Bạn có thể thử STT lại hoặc ghi lại câu trả lời." : "Bạn có thể thử STT lại hoặc nhập transcript; bản nhập tay sẽ cần giảng viên xem lại."}`,
        );
      } finally {
        setProcessing(false);
      }
    };
    activeRecorders.forEach((r) => {
      r.onstop = stopped;
    });
    const recordingError = () => {
      setDeviceError(
        "Có lỗi ghi media. Kiểm tra thiết bị và ghi lại câu trả lời.",
      );
      stopRef.current();
    };
    activeRecorders.forEach((r) => {
      r.onerror = recordingError;
    });
    recorders.current = activeRecorders;
    stopRef.current = () => {
      if (!recordingRef.current) return;
      recordingRef.current = false;
      for (const r of recorders.current) if (r.state !== "inactive") r.stop();
      setRecording(false);
    };
    autoSubmitRecording.current = false;
    activeRecorders.forEach((r) => r.start(1000));
    recordingRef.current = true;
    setRecording(true);
    setError("");
    return timing;
  }
  async function runUpload(job: UploadJob) {
    const update = (patch: Partial<UploadJob>) => {
      Object.assign(job, patch);
      for (const item of screenJobs.current.values())
        if (item.job.id === job.id) Object.assign(item.job, patch);
      setJobs((all) =>
        all.map((j) => (j.id === job.id ? { ...j, ...patch } : j)),
      );
      void updateUploadJobStatus(job.id, patch);
    };
    update({ status: "uploading", error: undefined });
    try {
      const init = await send<{
        id: string;
        chunk_size: number;
        status: string;
      }>("/uploads/init", {
        attempt_id: job.attemptId,
        kind: job.kind,
        mime_type: job.blob.type,
        size: job.blob.size,
        sha256: await hash(job.blob),
      });
      if (init.status !== "COMPLETED") {
        const state = await api<{ received_chunks: number[] }>(
          `/uploads/${init.id}/status`,
        );
        const count = Math.ceil(job.blob.size / init.chunk_size);
        for (let i = 0; i < count; i++) {
          if (!state.received_chunks.includes(i)) {
            const part = job.blob.slice(
              i * init.chunk_size,
              (i + 1) * init.chunk_size,
            );
            const checksum = await hash(part);
            let last: unknown;
            for (let retry = 0; retry < 5; retry++) {
              try {
                await api(`/uploads/${init.id}/chunks/${i}`, {
                  method: "PUT",
                  body: part,
                  headers: { "X-Chunk-Sha256": checksum },
                });
                last = null;
                break;
              } catch (e) {
                last = e;
                await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** retry)));
              }
            }
            if (last) throw last;
          }
          update({ progress: Math.round(((i + 1) / count) * 95) });
        }
        await send(`/uploads/${init.id}/complete`);
      }
      update({ status: "done", progress: 100 });
      void deleteUploadJob(job.id);
      return true;
    } catch (e) {
      update({ status: "failed", error: errorText(e) });
      return false;
    }
  }
  async function submit(pendingAnswer = answer, automatic = false) {
    const answer = pendingAnswer;
    if (!answer || !session || submitting || processing) return;
    if (guard.blocked || guard.preparing)
      throw new Error("Khôi phục chế độ thi trước khi nộp câu trả lời.");
    if (
      !serverProcessing &&
      !answer.transcript.trim() &&
      !answer.sttSkippedReason
    )
      throw new Error("Nhận dạng câu trả lời trước khi nộp.");
    if (!answer.audio.size) throw new Error("Media rỗng. Vui lòng ghi âm lại.");
    setSubmitting(true);
    try {
      const confidence =
        answer.transcript === answer.originalText ? answer.confidence : 0;
      await api(`/question-attempts/${answer.attemptId}/submit`, {
        method: "POST",
        body: JSON.stringify({
          transcript: serverProcessing ? "" : answer.transcript,
          stt_confidence: serverProcessing ? null : confidence,
          ...(serverProcessing ? { processing_mode: "server_audio" } : {}),
          ...(answer.sttSkippedReason
            ? { stt_skipped_reason: answer.sttSkippedReason }
            : {}),
        }),
        headers: { "Idempotency-Key": answer.key },
      });
      let added = answerUploads.current.get(answer.key);
      if (!added) {
        added = (["AUDIO"] as const).map((kind) => ({
          id: crypto.randomUUID(),
          attemptId: answer.attemptId,
          kind,
          blob: answer.audio,
          progress: 0,
          status: "pending",
        }));
        answerUploads.current.set(answer.key, added);
        const newJobs = added;
        setJobs((all) => [...all, ...newJobs]);
        for (const job of added) {
          void saveUploadJob({
            id: job.id,
            attemptId: job.attemptId,
            sessionId: session.id,
            kind: job.kind,
            blob: job.blob,
            progress: job.progress,
            status: job.status,
            updatedAt: Date.now(),
          });
        }
        void deletePendingAnswer(answer.attemptId);
      }
      setError("");
      if (automatic) {
        const uploaded = await Promise.all(
          added.map((job) => (job.status === "done" ? true : runUpload(job))),
        );
        const next = await refreshSession(session.id);
        setAnswer(null);
        answerUploads.current.delete(answer.key);
        if (!next.current_attempt && uploaded.every(Boolean))
          await finishExam(next);
      } else {
        added
          .filter((job) => ["pending", "failed"].includes(job.status))
          .forEach((job) => void runUpload(job));
        await refreshSession(session.id);
        setAnswer(null);
        answerUploads.current.delete(answer.key);
      }
    } finally {
      setSubmitting(false);
    }
  }
  async function finishExam(session: ExamSession) {
    try {
      const screens = await guard.stopRecording();
      if (
        session.screen_required &&
        !screens.length &&
        !jobs.some((j) => j.kind === "SCREEN" && j.status === "done")
      )
        throw new Error("Chưa có bản ghi màn hình để nộp. Liên hệ giảng viên.");
      for (const blob of screens) {
        const item = queueScreen(blob, session.screen_attempt_id!);
        await item.task;
        if (item.job.status !== "done")
          throw new Error(
            "Chưa tải xong màn hình. Bấm thử lại ở bản ghi lỗi, sau đó nộp bài.",
          );
      }
      setSession(
        await send<ExamSession>(`/exam-sessions/${session.id}/finish`),
      );
      await guard.release();
      void clearSessionState(session.id);
      void clearCompletedUploadJobs(session.id);
    } catch (e) {
      guard.finishFailed();
      throw e;
    }
  }
  function queueScreen(blob: Blob, attemptId: string) {
    const existing = screenJobs.current.get(blob);
    if (existing) return existing;
    const job: UploadJob = {
      id: crypto.randomUUID(),
      attemptId,
      kind: "SCREEN",
      blob,
      progress: 0,
      status: "pending",
    };
    setJobs((all) => [...all, job]);
    if (session?.id) {
      void saveUploadJob({
        id: job.id,
        attemptId: job.attemptId,
        sessionId: session.id,
        kind: job.kind,
        blob: job.blob,
        progress: job.progress,
        status: job.status,
        updatedAt: Date.now(),
      });
    }
    const item = { job, task: runUpload(job) };
    screenJobs.current.set(blob, item);
    return item;
  }
  useEffect(() => {
    if (session?.status !== "IN_PROGRESS" || !session.screen_attempt_id) return;
    for (const blob of guard.files())
      queueScreen(blob, session.screen_attempt_id);
    // A completed media segment triggers an upload, not each UI render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guard.segmentVersion, session?.id, session?.status]);
  async function openExam(
    examId: string,
    newAttempt = false,
    sessionId?: string,
  ) {
    await guard.release();
    screenJobs.current.clear();
    answerUploads.current.clear();
    setScreenConsent(false);
    const next = sessionId
      ? await api<ExamSession>(`/exam-sessions/${sessionId}`)
      : await send<ExamSession>("/exam-sessions", {
          exam_id: examId,
          new_attempt: newAttempt,
        });
    deviceGeneration.current++;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    await filterRef.current?.close();
    filterRef.current = null;
    await gainRef.current?.close();
    gainRef.current = null;
    setStream(null);
    setDeviceError("");
    setFilterError("");
    setNoiseReady(false);
    setAnswer(null);
    setJobs([]);
    setError("");
    localDeadline.current = null;
    setSession(next);
  }
  if (!session)
    return (
      <>
        <div className="page-heading">
          <div>
            <span className="eyebrow">SẴN SÀNG CHIA SẺ KIẾN THỨC</span>
            <h1>Bài thi của tôi</h1>
            <p className="muted">
              Kiểm tra thiết bị, đọc câu hỏi và trình bày bằng giọng nói của
              bạn.
            </p>
          </div>
          <Action action={loadExams} className="button ghost">
            <GraduationCap size={18} /> Làm mới bài thi
          </Action>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {desktopSpeech.desktop && <DesktopPolicySummary />}
        <label className="course-filter">
          Môn học
          <select
            value={courseFilter}
            onChange={(e) => setCourseFilter(e.target.value)}
          >
            <option value="">Tất cả môn học</option>
            {Array.from(
              new Map(
                exams
                  .filter((e) => e.course_id)
                  .map((e) => [e.course_id!, e.course_name || "Môn học"]),
              ),
            ).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="course-grid">
          {exams
            .filter(
              (e) =>
                !e.practice && (!courseFilter || e.course_id === courseFilter),
            )
            .map((e) => (
              <section className="panel" key={e.id}>
                <Badge status={submissionBadge(e.status)} />
                <p className="eyebrow">
                  {e.course_name}
                  {e.practice ? " · LUYỆN TẬP" : ""}
                </p>
                <h2>{e.name}</h2>
                <p className="muted">
                  {e.question_count} câu hỏi · {Math.round(e.time_limit / 60)}{" "}
                  phút
                </p>
                {e.workflow && (
                  <p>
                    Lịch vào thi:{" "}
                    {e.opens_at
                      ? new Date(e.opens_at * 1000).toLocaleString("vi-VN")
                      : "Chưa xếp lịch"}{" "}
                    →{" "}
                    {e.closes_at
                      ? new Date(e.closes_at * 1000).toLocaleString("vi-VN")
                      : "—"}
                  </p>
                )}
                <Action action={() => openExam(e.id)}>
                  {!e.session_id
                    ? "Mở bài thi →"
                    : ["DEVICE_CHECK", "IN_PROGRESS"].includes(e.status)
                      ? "Tiếp tục làm bài →"
                      : "Xem xác nhận nộp bài →"}
                </Action>
                {!!e.attempt_count && (
                  <>
                    <p className="muted">
                      Đã làm {e.attempt_count} lần ·{" "}
                      {e.remaining_attempts === null
                        ? "Làm lại không giới hạn"
                        : `Còn ${e.remaining_attempts} lượt`}
                    </p>
                    {e.can_start_new && (
                      <Action
                        className="button secondary"
                        action={() => openExam(e.id, true)}
                      >
                        Làm lại bài thi
                      </Action>
                    )}
                    <details>
                      <summary>
                        Lịch sử làm bài ({e.history?.length || 0})
                      </summary>
                      {e.history?.map((s) => (
                        <div className="list-item" key={s.id}>
                          <div>
                            <strong>Lần {s.attempt_number}</strong>
                            <p className="muted">
                              {new Date(s.created_at * 1000).toLocaleString(
                                "vi-VN",
                              )}
                            </p>
                            <Badge status={submissionBadge(s.status)} />
                          </div>
                          <Action
                            className="text-button"
                            action={() => openExam(e.id, false, s.id)}
                          >
                            Xem lần {s.attempt_number}
                          </Action>
                        </div>
                      ))}
                    </details>
                  </>
                )}
              </section>
            ))}
        </div>
        {!exams.length && (
          <Empty>
            Bạn chưa được giao bài thi. Vui lòng liên hệ giảng viên.
          </Empty>
        )}
      </>
    );
  const finished = ["SUBMITTED", "REVIEW_REQUIRED", "COMPLETED"].includes(
    session.status,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PHÒNG THI VẤN ĐÁP</span>
          <h1>
            {session.exam_name}
            {session.attempt_number ? ` · Lần ${session.attempt_number}` : ""}
          </h1>
          <p className="muted">
            Đã trả lời {session.answered_count}/{session.question_count} câu
          </p>
        </div>
        {session.started_at && !finished ? (
          <span className={`timer ${remaining < 60 ? "danger" : ""}`}>
            <Clock3 size={19} />
            {Math.floor(remaining / 60)}:
            {String(remaining % 60).padStart(2, "0")}
          </span>
        ) : (
          <Badge status={submissionBadge(session.status)} />
        )}
      </div>
      {!isOnline && (
        <div
          role="status"
          style={{
            background: "#fff3cd",
            color: "#856404",
            padding: "10px 14px",
            borderRadius: 8,
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: "0.95rem",
          }}
        >
          <span>⚠️ <strong>Mất kết nối mạng:</strong> Bài thi vẫn được lưu an toàn trong máy của bạn. Hệ thống sẽ tự động đồng bộ khi có kết nối trở lại.</span>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {desktopSpeech.desktop && session.desktop_policy && (
        <DesktopPolicySummary rules={session.desktop_policy} />
      )}
      {finished ? (
        <section className="panel finished">
          <CheckCircle2 size={52} />
          <h2>
            {session.practice
              ? "Đã hoàn thành bài luyện tập"
              : "Đã nộp bài thi"}
          </h2>
          <p>Câu trả lời và minh chứng đã được lưu.</p>
          <p>
            Bạn có thể đóng ứng dụng. Việc chấm và xem điểm được thực hiện trên
            web dành cho quản trị viên, khảo thí và giáo viên có quyền.
          </p>
          <button
            className="button secondary"
            onClick={() => {
              setSession(null);
              setStream(null);
              setJobs([]);
              localDeadline.current = null;
              void loadExams();
            }}
          >
            Về danh sách bài thi
          </button>
        </section>
      ) : (
        <div className="exam-grid">
          <section className="panel question-panel">
            {session.screen_required && (
              <p role="status">
                {guard.recording
                  ? "● Đang ghi toàn màn hình"
                  : "Bài thi yêu cầu ghi toàn màn hình"}
              </p>
            )}
            {guard.blocked && (
              <div className="notice" role="alert">
                <p>
                  Bài thi bị gián đoạn hoặc chưa bật ghi màn hình. Kết nối lại
                  để tiếp tục; thời gian thi vẫn chạy.
                </p>
                <Action
                  disabled={displayBusy || guard.preparing}
                  action={guard.prepare}
                >
                  Khôi phục chế độ thi
                </Action>
              </div>
            )}
            {guard.preparing && (
              <div role="status">
                <p>
                  {guard.prepareStage || "Đang bật chế độ thi và ghi màn hình…"}
                </p>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void guard.cancelPrepare()}
                >
                  Hủy khôi phục
                </button>
              </div>
            )}
            {desktopSpeech.desktop &&
              (session.desktop_policy?.single_display ?? true) &&
              !guard.preparing &&
              (session.status === "DEVICE_CHECK" || guard.blocked) && (
                <DesktopDisplaySettings
                  inExam={session.status === "IN_PROGRESS"}
                  onBusy={setDisplayBusy}
                />
              )}
            {!serverProcessing && (
              <DesktopSpeechSettings
                settings={desktopSpeech}
                disabled={
                  recording || startingRecording || processing || submitting
                }
              />
            )}
            {serverProcessing && (
              <p className="notice">
                Bản ghi được nhận dạng và chấm trên server sau khi nộp toàn bài,
                theo cấu hình STT của hệ thống.
              </p>
            )}
            {session.status === "DEVICE_CHECK" ? (
              <>
                <span className="eyebrow">TRƯỚC KHI BẮT ĐẦU</span>
                <h2>Kiểm tra thiết bị</h2>
                <p>
                  Bài thi gồm {session.question_count} câu, thời gian{" "}
                  {Math.round(session.time_limit / 60)} phút tính từ khi bắt đầu
                  thi.
                </p>
                <ol>
                  <li>
                    {cameraRequired
                      ? "Cho phép truy cập camera và microphone."
                      : "Cho phép truy cập microphone; lượt thi này không yêu cầu camera."}
                  </li>
                  <li>Kiểm tra thiết bị và thanh tín hiệu microphone.</li>
                  {!desktopSpeech.desktop && (
                    <li>
                      Kiểm tra độ ồn, tìm chỗ yên lặng nếu được nhắc hoặc chọn
                      bỏ qua.
                    </li>
                  )}
                  {cameraRequired && (
                    <li>Camera chỉ ghi khi bạn bấm “Bắt đầu trả lời”.</li>
                  )}
                </ol>
                <p className="muted">
                  Audio từng câu và video màn hình (khi bật) được lưu để giảng
                  viên xem lại. Chưa hỗ trợ khôi phục bản ghi khi đóng ứng dụng;
                  giữ cửa sổ mở đến khi nộp bài thành công.
                </p>
                {!desktopSpeech.desktop && (
                  <>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={denoise}
                        onChange={(event) => {
                          setDenoise(event.target.checked);
                        }}
                      />
                      Lọc nhiễu RNNoise khi nhận dạng câu trả lời
                    </label>
                    {filterError && (
                      <p role="alert" className="error">
                        {filterError}
                      </p>
                    )}
                    <p className="muted">
                      Mặc định STT dùng bản gốc. Audio gốc được giữ để đối
                      chiếu. Lựa chọn lọc chỉ áp dụng cho audio dùng STT.
                    </p>
                    {stream && !deviceError && (
                      <NoiseCheck
                        key={`${stream.id}:${gainDb}`}
                        stream={stream}
                        gainDb={gainDb}
                        onReady={setNoiseReady}
                      />
                    )}
                  </>
                )}
                {desktopSpeech.desktop && !serverProcessing && (
                  <p className="muted">
                    STT dùng bản ghi gốc từ microphone. Audio gốc được giữ để
                    đối chiếu. Nếu vẫn nhận nhiều màn hình dù đã tắt nguồn, dùng
                    nút Tắt màn hình phụ trong mục Chuẩn bị màn hình, rồi bấm
                    Bắt đầu thi.
                  </p>
                )}
                {session.screen_required && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={screenConsent}
                      onChange={(e) => setScreenConsent(e.target.checked)}
                    />
                    Tôi đồng ý ghi toàn màn hình trong thời gian làm bài và lưu
                    trên server để giảng viên xem lại. Tôi đã đóng thông tin
                    riêng tư. Các lần chuyển cửa sổ hoặc ngắt ghi sẽ được ghi
                    nhận.
                  </label>
                )}
                <Action
                  disabled={
                    !stream ||
                    !!deviceError ||
                    (!desktopSpeech.desktop && !noiseReady) ||
                    connecting ||
                    displayBusy ||
                    guard.preparing ||
                    processing ||
                    (session.screen_required && !screenConsent)
                  }
                  action={async () => {
                    if (
                      window.oralDesktop?.beginExam ||
                      session.screen_required ||
                      (desktopSpeech.desktop && session.desktop_policy)
                    )
                      await guard.prepare();
                    try {
                      setSession(
                        await send<ExamSession>(
                          `/exam-sessions/${session.id}/start`,
                          { screen_consent: screenConsent },
                        ),
                      );
                    } catch (e) {
                      await guard.release();
                      throw e;
                    }
                  }}
                >
                  Bắt đầu thi
                </Action>
              </>
            ) : session.current_attempt ? (
              <>
                <span className="eyebrow">
                  CÂU {session.current_attempt.sequence} /{" "}
                  {session.question_count}
                </span>
                <div className="question-text">
                  <QuestionContent
                    text={session.current_attempt.text}
                    content={session.current_attempt.rich_content}
                  />
                </div>
                {session.current_attempt.prompt_image && (
                  <Image
                    unoptimized
                    src={session.current_attempt.prompt_image}
                    alt="Tranh minh họa cho câu hỏi mô tả bằng tiếng Anh"
                    width={960}
                    height={540}
                    style={{
                      maxWidth: "100%",
                      height: "auto",
                      borderRadius: 12,
                    }}
                  />
                )}
                <div className="recording-status">
                  {recording ? (
                    <>
                      <span className="record-dot" />
                      Đang ghi âm câu trả lời
                      {timedQuestions
                        ? ` · Còn ${questionTimer.seconds} giây`
                        : ""}
                    </>
                  ) : processing ? (
                    <span
                      role="status"
                      aria-live="polite"
                      className="processing-status"
                    >
                      <LoaderCircle className="spin" size={20} />
                      {speechStage}
                    </span>
                  ) : submitting ? (
                    <span
                      role="status"
                      aria-live="polite"
                      className="processing-status"
                    >
                      <LoaderCircle className="spin" size={20} />
                      Đang nộp câu trả lời, vui lòng đợi…
                    </span>
                  ) : answer ? (
                    serverProcessing ? (
                      "Bản ghi đã sẵn sàng để nộp. Server sẽ nhận dạng và chấm sau khi bạn nộp toàn bài."
                    ) : desktopSpeech.desktop ? (
                      answer.transcript.trim() ? (
                        "Câu trả lời đã sẵn sàng để nộp."
                      ) : answer.sttSkippedReason ? (
                        "Đã bỏ qua STT vì thiếu model. Bạn có thể nộp bản ghi; câu trả lời chưa có transcript hoặc điểm AI và cần giảng viên xem lại."
                      ) : (
                        "Chưa nhận dạng được câu trả lời. Hãy thử STT lại hoặc ghi lại."
                      )
                    ) : (
                      "Kiểm tra transcript trước khi nộp"
                    )
                  ) : timedQuestions ? (
                    questionTimer.ready ? (
                      `Chuẩn bị: ${questionTimer.seconds} giây — tự động bắt đầu ghi`
                    ) : (
                      "Đang chuẩn bị câu hỏi…"
                    )
                  ) : (
                    "Dành một chút thời gian suy nghĩ trước khi trả lời."
                  )}
                </div>
                {timedQuestions && questionTimer.error && (
                  <p role="alert" className="error">
                    {questionTimer.error}
                  </p>
                )}
                {timedQuestions &&
                  questionTimer.error &&
                  !recording &&
                  !answer && (
                    <button
                      className="button secondary"
                      onClick={questionTimer.retry}
                    >
                      Thử kết nối ghi lại
                    </button>
                  )}
                {!answer &&
                  !processing &&
                  !submitting &&
                  (recording ? (
                    <button className="button stop" onClick={endAnswer}>
                      <Square size={17} />
                      Kết thúc trả lời
                    </button>
                  ) : !timedQuestions ? (
                    <Action
                      disabled={
                        guard.blocked ||
                        guard.preparing ||
                        !stream ||
                        !!deviceError ||
                        remaining === 0
                      }
                      action={start}
                    >
                      <Mic size={17} />
                      Bắt đầu trả lời
                    </Action>
                  ) : null)}
                {answer && (
                  <div className="answer-form">
                    {!serverProcessing && !desktopSpeech.desktop && (
                      <>
                        <label>
                          Transcript
                          <textarea
                            rows={7}
                            disabled={processing || submitting}
                            value={answer.transcript}
                            onChange={(e) =>
                              setAnswer({
                                ...answer,
                                transcript: e.target.value,
                              })
                            }
                            placeholder="Transcript từ giọng nói sẽ xuất hiện ở đây…"
                          />
                        </label>
                        <p className="muted">
                          Chỉnh sửa hoặc nhập tay sẽ đánh dấu câu trả lời cần
                          giảng viên đối chiếu với bản ghi.
                        </p>
                        <label>
                          Bản ghi dùng cho STT
                          <select
                            value={answer.sttSource}
                            disabled={processing || submitting}
                            onChange={(e) =>
                              setAnswer({
                                ...answer,
                                sttSource: e.target.value as
                                  "original" | "filtered",
                              })
                            }
                          >
                            <option value="original">Bản gốc</option>
                            <option
                              value="filtered"
                              disabled={!answer.filteredAudio}
                            >
                              Bản giảm nhiễu RNNoise
                            </option>
                          </select>
                        </label>
                        {!answer.filteredAudio && (
                          <p className="muted">
                            Không có bản giảm nhiễu hợp lệ cho lần ghi này. Bạn
                            vẫn có thể nhận dạng lại từ bản gốc.
                          </p>
                        )}
                      </>
                    )}
                    <div className="inline">
                      <Action
                        disabled={
                          guard.blocked ||
                          guard.preparing ||
                          processing ||
                          submitting ||
                          (!serverProcessing &&
                            !answer.transcript.trim() &&
                            !answer.sttSkippedReason)
                        }
                        action={() => submit(answer, timedQuestions)}
                      >
                        Nộp câu trả lời & tiếp tục →
                      </Action>
                      {!serverProcessing && (
                        <Action
                          disabled={processing || submitting}
                          className="button secondary"
                          action={async () => {
                            setProcessing(true);
                            try {
                              const audio =
                                !window.oralDesktop &&
                                answer.sttSource === "filtered"
                                  ? answer.filteredAudio
                                  : answer.audio;
                              if (!audio)
                                throw new Error(
                                  "Không có bản ghi đã lọc nhiễu.",
                                );
                              const s = await transcribe(audio);
                              // A missing model on retry must not erase the last
                              // successful transcript from this same recording.
                              if (
                                !s.stt_skipped_reason ||
                                !answer.transcript.trim()
                              )
                                setAnswer({
                                  ...answer,
                                  transcript: s.transcript,
                                  originalText: s.transcript,
                                  confidence: s.stt_confidence,
                                  sttSkippedReason: s.stt_skipped_reason,
                                });
                              setError("");
                            } finally {
                              setProcessing(false);
                            }
                          }}
                        >
                          Thử STT lại
                        </Action>
                      )}
                      {!timedQuestions && (
                        <button
                          disabled={processing || submitting}
                          className="text-button"
                          onClick={() => {
                            setAnswer(null);
                            setError("");
                          }}
                        >
                          Ghi lại
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <CheckCircle2 size={44} />
                <h2>Đã trả lời đủ câu hỏi</h2>
                <p>Chờ minh chứng tải lên hoàn tất, sau đó nộp bài thi.</p>
              </>
            )}
            {session.status === "IN_PROGRESS" &&
              (!session.current_attempt || remaining === 0) &&
              !recording &&
              !answer && (
                <Action
                  disabled={jobs.some((j) => j.status !== "done")}
                  action={() => finishExam(session)}
                >
                  Nộp bài thi
                </Action>
              )}
          </section>
          <aside>
            <section className="panel device-panel">
              <div className="section-title">
                <h3>
                  <Camera size={17} />
                  {cameraRequired ? "Camera của bạn" : "Microphone của bạn"}
                </h3>
                <span className={recording ? "record-label" : "muted"}>
                  {recording ? "REC" : "Preview"}
                </span>
              </div>
              {cameraRequired && (
                <div
                  className="camera-preview"
                  style={{ aspectRatio: cameraRatio }}
                >
                  <video
                    ref={preview}
                    autoPlay
                    playsInline
                    muted
                    onLoadedMetadata={(e) => {
                      const video = e.currentTarget;
                      if (video.videoWidth && video.videoHeight)
                        setCameraRatio(video.videoWidth / video.videoHeight);
                    }}
                  />
                  {!stream && (
                    <span>
                      <Camera size={34} />
                      Chưa kết nối camera
                    </span>
                  )}
                </div>
              )}
              <div className="mic-meter">
                <Mic size={16} />
                <div>
                  <i style={{ width: `${micLevel}%` }} />
                </div>
              </div>
              <small className="muted mic-status">
                <span
                  className="mic-status-hint"
                  title="Nói thử để kiểm tra tín hiệu microphone."
                >
                  Nói thử để kiểm tra microphone.
                </span>
                <span className="mic-status-peak">
                  Mức đỉnh:
                  <span className="mic-status-value">
                    {stream?.active ? micPeak.toFixed(1) : "—"}
                  </span>
                  dBFS
                </span>
              </small>
              {stream && micPeak >= -1 && (
                <p role="status" className="error">
                  {desktopSpeech.desktop
                    ? "Âm quá lớn, có nguy cơ vỡ tiếng. Đưa mic ra xa hoặc chỉnh mức mic trong hệ điều hành."
                    : "Âm quá lớn, có nguy cơ vỡ tiếng. Giảm gain hoặc đưa mic ra xa."}
                </p>
              )}
              <fieldset
                className="device-selectors"
                disabled={
                  connecting ||
                  startingRecording ||
                  recording ||
                  processing ||
                  submitting
                }
              >
                <legend>Chọn thiết bị</legend>
                {!desktopSpeech.desktop && (
                  <>
                    <label>
                      Gain microphone ({gainDb > 0 ? "+" : ""}
                      {gainDb} dB)
                      <input
                        aria-label="Gain microphone"
                        type="range"
                        min={-12}
                        max={18}
                        step={1}
                        value={gainDb}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          gainRef.current?.setGain(value);
                          setGainDb(value);
                          setNoiseReady(false);
                        }}
                      />
                    </label>
                    <p className="muted">
                      0 dB giữ nguyên mức mic. Tăng từng ít một nếu giọng nhỏ;
                      giảm nếu rè. Áp dụng cho bản thu audio mới và STT. Thu thử
                      lại sau khi chỉnh.
                    </p>
                  </>
                )}
                {(
                  [
                    ["audioinput", "Microphone", microphoneId],
                    ["videoinput", "Camera", cameraId],
                  ] as const
                ).map(([kind, label, selected]) => {
                  if (kind === "videoinput" && !cameraRequired) return null;
                  const options = availableDevices.filter(
                    (d) => d.kind === kind && d.deviceId,
                  );
                  return (
                    <label key={kind}>
                      {label}
                      <select
                        value={selected}
                        onChange={(event) => {
                          const id = event.target.value;
                          if (kind === "audioinput") {
                            setMicrophoneId(id);
                            void devices(id, cameraId);
                          } else {
                            setCameraId(id);
                            void devices(microphoneId, id);
                          }
                        }}
                      >
                        <option value="">Mặc định hệ thống</option>
                        {selected &&
                          !options.some((d) => d.deviceId === selected) && (
                            <option value={selected} disabled>
                              Thiết bị đã chọn (không có trong danh sách)
                            </option>
                          )}
                        {options.map((d, index) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || `${label} ${index + 1}`}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </fieldset>
              <p className="muted">
                Cấp quyền để xem đầy đủ tên thiết bị. Chọn thiết bị sẽ kết nối
                ngay.
                {!desktopSpeech.desktop &&
                  " Đổi thiết bị trước khi thi cần kiểm tra mic lại hoặc bỏ qua."}
              </p>
              {connecting && (
                <p role="status">Đang kết nối thiết bị đã chọn…</p>
              )}
              {deviceListError && (
                <p role="alert" className="error">
                  {deviceListError}
                </p>
              )}
              {deviceError && (
                <p role="alert" className="error">
                  {deviceError}
                </p>
              )}
              <Action
                disabled={
                  recording ||
                  processing ||
                  submitting ||
                  connecting ||
                  startingRecording
                }
                className="button secondary"
                action={devices}
              >
                {stream
                  ? "Kết nối lại thiết bị"
                  : cameraRequired
                    ? "Cho phép camera & mic"
                    : "Cho phép microphone"}
              </Action>
            </section>
            <section className="panel">
              <h3>
                <UploadCloud size={18} />
                Minh chứng
              </h3>
              {!jobs.length ? (
                <p className="muted">
                  Chỉ audio được tải lên sau mỗi câu. Video màn hình được lưu
                  cho cả lượt thi khi bật ghi màn hình.
                </p>
              ) : (
                jobs.map((j) => (
                  <div className="upload-job" key={j.id}>
                    <div>
                      <span>
                        {j.kind === "AUDIO"
                          ? "Âm thanh"
                          : j.kind === "SCREEN"
                            ? "Màn hình bài thi"
                            : "Camera câu trả lời"}
                      </span>
                      <small>
                        {j.status === "done" ? "Đã lưu" : `${j.progress}%`}
                      </small>
                    </div>
                    <progress max="100" value={j.progress} />
                    {j.status === "failed" && (
                      <>
                        <p className="error">{j.error}</p>
                        <Action
                          className="text-button"
                          action={() => runUpload(j)}
                        >
                          Tải lại
                        </Action>
                      </>
                    )}
                  </div>
                ))
              )}
            </section>
          </aside>
        </div>
      )}
    </>
  );
}
