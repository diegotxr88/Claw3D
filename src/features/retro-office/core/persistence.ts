import {
  ATM_MIGRATION_KEY,
  GYM_ROOM_MIGRATION_KEY,
  PHONE_BOOTH_MIGRATION_KEY,
  QA_LAB_MIGRATION_KEY,
  SMS_BOOTH_MIGRATION_KEY,
  SERVER_ROOM_MIGRATION_KEY,
  STORAGE_KEY,
} from "@/features/retro-office/core/constants";
import type { FurnitureItem } from "@/features/retro-office/core/types";

const resolveStorageKey = (key: string, namespace = "default") =>
  namespace === "default" ? key : `${key}:${namespace}`;

const CAMERA_VIEW_STORAGE_KEY = "openclaw-office-camera-view-v1";

const hasStorageFlag = (key: string, namespace = "default") => {
  try {
    return localStorage.getItem(resolveStorageKey(key, namespace)) === "1";
  } catch {
    return false;
  }
};

const markStorageFlag = (key: string, namespace = "default") => {
  try {
    localStorage.setItem(resolveStorageKey(key, namespace), "1");
  } catch {
    /* ignore */
  }
};

export const saveFurniture = (items: FurnitureItem[], namespace = "default") => {
  try {
    localStorage.setItem(resolveStorageKey(STORAGE_KEY, namespace), JSON.stringify(items));
  } catch {
    /* ignore */
  }
};

export const loadFurniture = (namespace = "default"): FurnitureItem[] | null => {
  try {
    const raw = localStorage.getItem(resolveStorageKey(STORAGE_KEY, namespace));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as FurnitureItem[])
      : null;
  } catch {
    return null;
  }
};

export type PersistedCameraView = {
  pos: [number, number, number];
  target: [number, number, number];
  zoom?: number;
};

export const saveCameraView = (
  view: PersistedCameraView,
  namespace = "default",
) => {
  try {
    localStorage.setItem(
      resolveStorageKey(CAMERA_VIEW_STORAGE_KEY, namespace),
      JSON.stringify(view),
    );
  } catch {
    /* ignore */
  }
};

export const loadCameraView = (
  namespace = "default",
): PersistedCameraView | null => {
  try {
    const raw = localStorage.getItem(
      resolveStorageKey(CAMERA_VIEW_STORAGE_KEY, namespace),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      !Array.isArray(parsed.pos) ||
      parsed.pos.length !== 3 ||
      !Array.isArray(parsed.target) ||
      parsed.target.length !== 3
    ) {
      return null;
    }
    return {
      pos: [Number(parsed.pos[0]), Number(parsed.pos[1]), Number(parsed.pos[2])],
      target: [
        Number(parsed.target[0]),
        Number(parsed.target[1]),
        Number(parsed.target[2]),
      ],
      zoom:
        typeof parsed.zoom === "number" && Number.isFinite(parsed.zoom)
          ? parsed.zoom
          : undefined,
    };
  } catch {
    return null;
  }
};

export const hasAtmMigrationApplied = (namespace = "default") =>
  hasStorageFlag(ATM_MIGRATION_KEY, namespace);

export const markAtmMigrationApplied = (namespace = "default") => {
  markStorageFlag(ATM_MIGRATION_KEY, namespace);
};

export const hasServerRoomMigrationApplied = (namespace = "default") =>
  hasStorageFlag(SERVER_ROOM_MIGRATION_KEY, namespace);

export const markServerRoomMigrationApplied = (namespace = "default") => {
  markStorageFlag(SERVER_ROOM_MIGRATION_KEY, namespace);
};

export const hasGymRoomMigrationApplied = (namespace = "default") =>
  hasStorageFlag(GYM_ROOM_MIGRATION_KEY, namespace);

export const markGymRoomMigrationApplied = (namespace = "default") => {
  markStorageFlag(GYM_ROOM_MIGRATION_KEY, namespace);
};

export const hasQaLabMigrationApplied = (namespace = "default") =>
  hasStorageFlag(QA_LAB_MIGRATION_KEY, namespace);

export const markQaLabMigrationApplied = (namespace = "default") => {
  markStorageFlag(QA_LAB_MIGRATION_KEY, namespace);
};

export const hasPhoneBoothMigrationApplied = (namespace = "default") =>
  hasStorageFlag(PHONE_BOOTH_MIGRATION_KEY, namespace);

export const markPhoneBoothMigrationApplied = (namespace = "default") => {
  markStorageFlag(PHONE_BOOTH_MIGRATION_KEY, namespace);
};

export const hasSmsBoothMigrationApplied = (namespace = "default") =>
  hasStorageFlag(SMS_BOOTH_MIGRATION_KEY, namespace);

export const markSmsBoothMigrationApplied = (namespace = "default") => {
  markStorageFlag(SMS_BOOTH_MIGRATION_KEY, namespace);
};
