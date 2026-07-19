import type { HandObservation, RawHandObservation } from './types';

interface Track {
  id: string;
  handedness: RawHandObservation['handedness'];
  wrist: { x: number; y: number };
  lastSeen: number;
}

interface Candidate {
  detectionIndex: number;
  trackId: string;
  cost: number;
}

export class HandAssociator {
  private readonly tracks = new Map<string, Track>();
  private nextId = 1;

  update(
    detections: RawHandObservation[],
    timestamp: number,
    inferenceMs: number,
  ): HandObservation[] {
    for (const [id, track] of this.tracks) {
      if (timestamp - track.lastSeen > 350) this.tracks.delete(id);
    }

    const candidates: Candidate[] = [];
    detections.forEach((detection, detectionIndex) => {
      const wrist = detection.landmarks[0];
      if (!wrist) return;
      for (const track of this.tracks.values()) {
        const distance = Math.hypot(wrist.x - track.wrist.x, wrist.y - track.wrist.y);
        const handednessPenalty = detection.handedness === track.handedness ? 0 : 0.32;
        candidates.push({
          detectionIndex,
          trackId: track.id,
          cost: distance + handednessPenalty,
        });
      }
    });

    candidates.sort((a, b) => a.cost - b.cost);
    const assignments = new Map<number, string>();
    const usedTracks = new Set<string>();
    for (const candidate of candidates) {
      if (
        candidate.cost > 0.72 ||
        assignments.has(candidate.detectionIndex) ||
        usedTracks.has(candidate.trackId)
      ) {
        continue;
      }
      assignments.set(candidate.detectionIndex, candidate.trackId);
      usedTracks.add(candidate.trackId);
    }

    return detections.flatMap((detection, index) => {
      const wrist = detection.landmarks[0];
      if (!wrist) return [];

      let id = assignments.get(index);
      if (!id) id = `hand-${this.nextId++}`;

      this.tracks.set(id, {
        id,
        handedness: detection.handedness,
        wrist: { x: wrist.x, y: wrist.y },
        lastSeen: timestamp,
      });

      return [
        {
          ...detection,
          id,
          timestamp,
          inferenceMs,
        },
      ];
    });
  }

  reset(): void {
    this.tracks.clear();
    this.nextId = 1;
  }
}
