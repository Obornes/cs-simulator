import { z } from "zod";
import { ChargingProfileSchema } from "./messages/_common";

type ChargingProfile = z.infer<typeof ChargingProfileSchema>;

interface StoredChargingProfile extends ChargingProfile {
  connectorId: number;
  storedAt: Date;
}

export class ChargingProfileManager {
  private profiles: Map<string, StoredChargingProfile> = new Map();

  setProfile(connectorId: number, profile: ChargingProfile): void {
    const key = this.getProfileKey(connectorId, profile);
    this.profiles.set(key, {
      ...profile,
      connectorId,
      storedAt: new Date(),
    });
  }

  clearProfiles(criteria: {
    id?: number;
    connectorId?: number;
    chargingProfilePurpose?:
      | "ChargePointMaxProfile"
      | "TxDefaultProfile"
      | "TxProfile";
    stackLevel?: number;
  }): void {
    const keysToDelete: string[] = [];

    for (const [key, profile] of this.profiles.entries()) {
      let matches = true;

      if (
        criteria.id !== undefined &&
        profile.chargingProfileId !== criteria.id
      ) {
        matches = false;
      }

      if (
        criteria.connectorId !== undefined &&
        profile.connectorId !== criteria.connectorId
      ) {
        matches = false;
      }

      if (
        criteria.chargingProfilePurpose !== undefined &&
        profile.chargingProfilePurpose !== criteria.chargingProfilePurpose
      ) {
        matches = false;
      }

      if (
        criteria.stackLevel !== undefined &&
        profile.stackLevel !== criteria.stackLevel
      ) {
        matches = false;
      }

      if (matches) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.profiles.delete(key);
    }
  }

  getPowerLimit(
    connectorId: number,
    transactionId: number | null,
    currentTime: Date = new Date(),
  ): number | null {
    const applicableProfiles: StoredChargingProfile[] = [];

    for (const profile of this.profiles.values()) {
      if (profile.connectorId !== connectorId) {
        continue;
      }

      if (profile.chargingProfilePurpose === "TxProfile") {
        if (profile.transactionId !== transactionId) {
          continue;
        }
      } else if (profile.chargingProfilePurpose === "TxDefaultProfile") {
        if (transactionId === null) {
          continue;
        }
      } else if (profile.chargingProfilePurpose === "ChargePointMaxProfile") {
        // ChargePointMaxProfile applies to the whole charge point
      }

      if (profile.validFrom) {
        const validFrom = new Date(profile.validFrom);
        if (currentTime < validFrom) {
          continue;
        }
      }

      if (profile.validTo) {
        const validTo = new Date(profile.validTo);
        if (currentTime > validTo) {
          continue;
        }
      }

      applicableProfiles.push(profile);
    }

    if (applicableProfiles.length === 0) {
      return null;
    }

    applicableProfiles.sort((a, b) => {
      const purposePriority: Record<string, number> = {
        TxProfile: 3,
        TxDefaultProfile: 2,
        ChargePointMaxProfile: 1,
      };

      const priorityDiff =
        purposePriority[b.chargingProfilePurpose] -
        purposePriority[a.chargingProfilePurpose];

      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return b.stackLevel - a.stackLevel;
    });

    const selectedProfile = applicableProfiles[0];
    return this.getLimitFromSchedule(selectedProfile, currentTime);
  }

  private getLimitFromSchedule(
    profile: StoredChargingProfile,
    currentTime: Date,
  ): number {
    const schedule = profile.chargingSchedule;

    let scheduleStartTime: Date;

    if (profile.chargingProfileKind === "Absolute") {
      scheduleStartTime = schedule.startSchedule
        ? new Date(schedule.startSchedule)
        : profile.storedAt;
    } else if (profile.chargingProfileKind === "Relative") {
      scheduleStartTime = profile.storedAt;
    } else {
      scheduleStartTime = profile.storedAt;
    }

    const elapsedSeconds = Math.floor(
      (currentTime.getTime() - scheduleStartTime.getTime()) / 1000,
    );

    let applicablePeriod = schedule.chargingSchedulePeriod[0];

    for (let i = schedule.chargingSchedulePeriod.length - 1; i >= 0; i--) {
      const period = schedule.chargingSchedulePeriod[i];
      if (elapsedSeconds >= period.startPeriod) {
        applicablePeriod = period;
        break;
      }
    }

    if (schedule.duration !== null && schedule.duration !== undefined) {
      if (elapsedSeconds > schedule.duration) {
        return 0;
      }
    }

    let limitInWatts = applicablePeriod.limit;

    if (schedule.chargingRateUnit === "A") {
      limitInWatts = applicablePeriod.limit * 230;
    }

    return limitInWatts;
  }

  private getProfileKey(connectorId: number, profile: ChargingProfile): string {
    return `${connectorId}-${profile.chargingProfileId}-${profile.stackLevel}`;
  }

  getProfilesForConnector(connectorId: number): StoredChargingProfile[] {
    return Array.from(this.profiles.values()).filter(
      (p) => p.connectorId === connectorId,
    );
  }
}

export const chargingProfileManager = new ChargingProfileManager();

