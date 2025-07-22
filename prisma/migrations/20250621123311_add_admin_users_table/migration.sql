-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "username" TEXT,
    "added_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_telegram_id_key" ON "admin_users"("telegram_id");
