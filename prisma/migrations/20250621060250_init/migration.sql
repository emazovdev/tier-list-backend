-- CreateEnum
CREATE TYPE "Role" AS ENUM ('user', 'admin');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegram_id" TEXT NOT NULL,
    "username" TEXT,
    "role" "Role" NOT NULL DEFAULT 'user',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegram_id_key" ON "users"("telegram_id");
