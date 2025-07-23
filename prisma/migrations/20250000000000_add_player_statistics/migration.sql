-- CreateTable
CREATE TABLE "player_statistics" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "category_name" TEXT NOT NULL,
    "total_games" INTEGER NOT NULL DEFAULT 0,
    "category_hits" INTEGER NOT NULL DEFAULT 0,
    "hit_percentage" DECIMAL(5,2) NOT NULL DEFAULT 0.00,
    "last_updated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex  
CREATE INDEX "player_statistics_player_id_idx" ON "player_statistics"("player_id");

-- CreateIndex
CREATE INDEX "player_statistics_club_id_idx" ON "player_statistics"("club_id");

-- CreateIndex
CREATE INDEX "player_statistics_category_name_idx" ON "player_statistics"("category_name");

-- CreateIndex
CREATE UNIQUE INDEX "player_statistics_player_id_category_name_key" ON "player_statistics"("player_id", "category_name");

-- AddForeignKey
ALTER TABLE "player_statistics" ADD CONSTRAINT "player_statistics_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_statistics" ADD CONSTRAINT "player_statistics_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE; 