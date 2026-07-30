-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('draft', 'objective_submitted', 'partners_recommended', 'partner_approved', 'outreach_approval_required', 'outreach_approved', 'outreach_sent', 'partner_accepted', 'circle_add_pending', 'circle_added', 'campaign_active', 'awaiting_deliverable', 'follow_up_due', 'follow_up_generating', 'follow_up_sent', 'deliverable_received', 'final_approval_required', 'completed', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "RecommendationVerdict" AS ENUM ('recommended', 'consider', 'reject');

-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('none', 'contacted', 'active', 'collaborated', 'declined', 'opted_out');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('partner_selection', 'first_outreach', 'final_deliverable', 'circle_removal');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "DeliverableStatus" AS ENUM ('pending', 'awaiting_submission', 'submitted', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AgentActionStatus" AS ENUM ('proposed', 'awaiting_approval', 'approved', 'rejected', 'attempted', 'succeeded', 'failed', 'skipped');

-- CreateEnum
CREATE TYPE "CircleMembershipStatus" AS ENUM ('pending', 'active', 'already_member', 'removed', 'failed');

-- CreateEnum
CREATE TYPE "OutboundMessageKind" AS ENUM ('outreach', 'follow_up', 'completion_notice');

-- CreateEnum
CREATE TYPE "MindExchangePurpose" AS ENUM ('partner_ranking', 'partner_ranking_repair', 'campaign_brief', 'follow_up_message', 'campaign_debrief', 'connectivity_check');

-- CreateTable
CREATE TABLE "CreatorProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "brandVoice" TEXT NOT NULL,
    "prohibitedTopics" TEXT[],
    "mindConversationAlias" TEXT NOT NULL,
    "mindConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Partner" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "audienceDescription" TEXT NOT NULL,
    "collaborationPreferences" TEXT NOT NULL,
    "audienceSize" INTEGER NOT NULL,
    "reliabilityScore" DOUBLE PRECISION,
    "safetyFlags" TEXT[],
    "isSynthetic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'none',
    "previousResponse" TEXT,
    "rejectionReason" TEXT,
    "collaborationCount" INTEGER NOT NULL DEFAULT 0,
    "performanceScore" DOUBLE PRECISION,
    "reliabilityScore" DOUBLE PRECISION,
    "preferredCommunicationStyle" TEXT,
    "lastContactedAt" TIMESTAMP(3),
    "optedOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'draft',
    "approvedPartnerId" TEXT,
    "deadline" TIMESTAMP(3),
    "nextActionAt" TIMESTAMP(3),
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartnerRecommendation" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "partnerId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "fitScore" DOUBLE PRECISION NOT NULL,
    "recommendation" "RecommendationVerdict" NOT NULL,
    "reasons" TEXT[],
    "risks" TEXT[],
    "memoryUsed" TEXT[],
    "rawMindResponseReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "actionType" "ApprovalActionType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deliverable" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DeliverableStatus" NOT NULL DEFAULT 'pending',
    "dueAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "submissionUrl" TEXT,
    "submissionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deliverable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "correlationId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT,
    "status" "AgentActionStatus" NOT NULL,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "autonomous" BOOLEAN NOT NULL DEFAULT false,
    "proposedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "externalReference" TEXT,
    "transport" TEXT,
    "errorCode" TEXT,
    "sanitisedErrorMessage" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleMembership" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "mindId" TEXT NOT NULL,
    "collaboratorEmail" TEXT NOT NULL,
    "status" "CircleMembershipStatus" NOT NULL DEFAULT 'pending',
    "addedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircleMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignBrief" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "talkingPoints" TEXT[],
    "toneNotes" TEXT,
    "successMetric" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignBrief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "OutboundMessageKind" NOT NULL,
    "transport" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "externalReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MindExchange" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "correlationId" TEXT NOT NULL,
    "purpose" "MindExchangePurpose" NOT NULL,
    "alias" TEXT NOT NULL,
    "baselineFingerprint" TEXT,
    "replyFingerprint" TEXT,
    "requestText" TEXT NOT NULL,
    "replyText" TEXT,
    "validated" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MindExchange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorProfile_mindConversationAlias_key" ON "CreatorProfile"("mindConversationAlias");

-- CreateIndex
CREATE UNIQUE INDEX "Partner_email_key" ON "Partner"("email");

-- CreateIndex
CREATE INDEX "Relationship_partnerId_idx" ON "Relationship"("partnerId");

-- CreateIndex
CREATE UNIQUE INDEX "Relationship_creatorId_partnerId_key" ON "Relationship"("creatorId", "partnerId");

-- CreateIndex
CREATE INDEX "Campaign_status_nextActionAt_idx" ON "Campaign"("status", "nextActionAt");

-- CreateIndex
CREATE INDEX "Campaign_creatorId_idx" ON "Campaign"("creatorId");

-- CreateIndex
CREATE INDEX "PartnerRecommendation_campaignId_rank_idx" ON "PartnerRecommendation"("campaignId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "PartnerRecommendation_campaignId_partnerId_key" ON "PartnerRecommendation"("campaignId", "partnerId");

-- CreateIndex
CREATE INDEX "Approval_campaignId_status_idx" ON "Approval"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Deliverable_campaignId_idx" ON "Deliverable"("campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_dedupeKey_key" ON "AgentAction"("dedupeKey");

-- CreateIndex
CREATE INDEX "AgentAction_campaignId_createdAt_idx" ON "AgentAction"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentAction_correlationId_idx" ON "AgentAction"("correlationId");

-- CreateIndex
CREATE INDEX "CircleMembership_mindId_idx" ON "CircleMembership"("mindId");

-- CreateIndex
CREATE UNIQUE INDEX "CircleMembership_campaignId_collaboratorEmail_key" ON "CircleMembership"("campaignId", "collaboratorEmail");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignBrief_campaignId_key" ON "CampaignBrief"("campaignId");

-- CreateIndex
CREATE INDEX "OutboundMessage_campaignId_createdAt_idx" ON "OutboundMessage"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "MindExchange_campaignId_createdAt_idx" ON "MindExchange"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "MindExchange_correlationId_idx" ON "MindExchange"("correlationId");

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_approvedPartnerId_fkey" FOREIGN KEY ("approvedPartnerId") REFERENCES "Partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerRecommendation" ADD CONSTRAINT "PartnerRecommendation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerRecommendation" ADD CONSTRAINT "PartnerRecommendation_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deliverable" ADD CONSTRAINT "Deliverable_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMembership" ADD CONSTRAINT "CircleMembership_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignBrief" ADD CONSTRAINT "CampaignBrief_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundMessage" ADD CONSTRAINT "OutboundMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MindExchange" ADD CONSTRAINT "MindExchange_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
