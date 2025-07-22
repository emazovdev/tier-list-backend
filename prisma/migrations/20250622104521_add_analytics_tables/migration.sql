-- CreateTable
CREATE TABLE "user_events" (
    "id" TEXT NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "game_sessions" (
    "id" TEXT NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "club_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "is_completed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_events_telegram_id_idx" ON "user_events"("telegram_id");

-- CreateIndex
CREATE INDEX "user_events_event_type_idx" ON "user_events"("event_type");

-- CreateIndex
CREATE INDEX "user_events_created_at_idx" ON "user_events"("created_at");

-- CreateIndex
CREATE INDEX "game_sessions_telegram_id_idx" ON "game_sessions"("telegram_id");

-- CreateIndex
CREATE INDEX "game_sessions_is_completed_idx" ON "game_sessions"("is_completed");
