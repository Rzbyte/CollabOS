-- CreateTable
CREATE TABLE "CampaignOutcome" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "submittedOnTime" BOOLEAN NOT NULL,
    "hoursLate" DOUBLE PRECISION,
    "neededFollowUp" BOOLEAN NOT NULL,
    "reliabilityBefore" DOUBLE PRECISION,
    "reliabilityAfter" DOUBLE PRECISION,
    "creatorReportedPerformance" DOUBLE PRECISION,
    "whatWorked" TEXT[],
    "whatToImprove" TEXT[],
    "futurePartnerGuidance" TEXT,
    "debriefMemoryUsed" TEXT[],
    "debriefExchangeReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CampaignOutcome_campaignId_key" ON "CampaignOutcome"("campaignId");

-- AddForeignKey
ALTER TABLE "CampaignOutcome" ADD CONSTRAINT "CampaignOutcome_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
