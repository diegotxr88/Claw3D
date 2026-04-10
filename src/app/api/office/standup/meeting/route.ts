import { NextResponse } from "next/server";

import {
  advanceStandupMeeting,
  recoverStandupMeetingIfNeeded,
  startStandupSpeaker,
  updateStandupArrivals,
} from "@/lib/office/standup/service";
import {
  loadActiveStandupMeeting,
  saveStandupMeeting,
  updateStandupMeeting,
} from "@/lib/office/standup/store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const recoveredMeeting = recoverStandupMeetingIfNeeded(loadActiveStandupMeeting());
    if (recoveredMeeting) {
      saveStandupMeeting(recoveredMeeting);
    }
    return NextResponse.json(
      { meeting: recoveredMeeting },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load standup meeting.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as {
      action?: "arrivals" | "start" | "advance" | "complete";
      arrivedAgentIds?: string[];
      speakerAgentId?: string | null;
    };
    const action = typeof body.action === "string" ? body.action : "";
    if (!action) {
      return NextResponse.json({ error: "action is required." }, { status: 400 });
    }
    const store = updateStandupMeeting((meeting) => {
      if (!meeting) return null;
      let nextMeeting = meeting;
      if (action === "arrivals") {
        nextMeeting = updateStandupArrivals(meeting, body.arrivedAgentIds ?? []);
        return recoverStandupMeetingIfNeeded(nextMeeting);
      }
      if (action === "start") {
        const speakerAgentId =
          typeof body.speakerAgentId === "string" ? body.speakerAgentId.trim() : null;
        nextMeeting = startStandupSpeaker(meeting, speakerAgentId);
        return recoverStandupMeetingIfNeeded(nextMeeting);
      }
      if (action === "advance") {
        nextMeeting = advanceStandupMeeting(meeting);
        return recoverStandupMeetingIfNeeded(nextMeeting);
      }
      if (action === "complete") {
        nextMeeting = startStandupSpeaker(meeting, null);
        return recoverStandupMeetingIfNeeded(nextMeeting);
      }
      return recoverStandupMeetingIfNeeded(nextMeeting);
    });
    return NextResponse.json(
      { meeting: store.activeMeeting },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update standup meeting.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
