import { api } from "@atelier/backend/api";
import type { Id } from "@atelier/backend/dataModel";
import { useMutation, useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import {
  includedParticipantIds,
  toggleExcluded,
} from "../lib/review-participants";
import { Body, Button, Field, Muted } from "./ui";

export const Reviews = ({
  roomId,
  participants,
}: {
  roomId: Id<"rooms">;
  participants: { _id: Id<"participants">; displayName: string }[];
}) => {
  const reviews = useQuery(api.rituals.list, { roomId });
  const begin = useMutation(api.rituals.begin);
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const startReview = async () => {
    setBusy(true);
    try {
      const id = await begin({
        participantIds: includedParticipantIds(participants, excluded),
        request,
        roomId,
      });
      setRequest("");
      setError("");
      setOpen(false);
      router.push({ params: { id }, pathname: "/ritual/[id]" });
    } catch (error_) {
      setError(String(error_));
    }
    setBusy(false);
  };

  const showError = (error_: unknown) => {
    setError(String(error_));
  };

  return (
    <View style={{ gap: 8, paddingBottom: 12 }}>
      <Button
        kind="secondary"
        label={open ? "Close review composer" : "Independent review"}
        onPress={() => {
          setOpen(!open);
        }}
      />
      {open && (
        <>
          <Muted>
            Answers stay sealed until everyone finishes. Reviews use a shared
            snapshot of tracked project files with execution tools disabled.
          </Muted>
          {participants.map((p) => (
            <Button
              kind="secondary"
              key={p._id}
              label={`${excluded.includes(p._id) ? "○" : "✓"} ${p.displayName}`}
              onPress={() => {
                setExcluded((ids) => toggleExcluded(ids, p._id));
              }}
            />
          ))}
          <Field
            accessibilityLabel="Review request"
            placeholder="Review request"
            value={request}
            onChangeText={setRequest}
            multiline
          />
          <Button
            label="Start review"
            disabled={
              busy ||
              !request.trim() ||
              includedParticipantIds(participants, excluded).length === 0
            }
            onPress={() => {
              startReview().catch(showError);
            }}
          />
        </>
      )}
      {error ? <Body>{error}</Body> : null}
      {reviews?.map((r) => (
        <Button
          key={r._id}
          kind="secondary"
          label={`${r.status === "collecting" ? "Collecting" : "Complete"} · ${r.request.slice(0, 70)}`}
          onPress={() => {
            router.push({ params: { id: r._id }, pathname: "/ritual/[id]" });
          }}
        />
      ))}
    </View>
  );
};
