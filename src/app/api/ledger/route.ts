import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { SignalLedger, SignalStatus } from "@/lib/models/SignalLedger";
import { todayIST } from "@/lib/timezone";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const status = req.nextUrl.searchParams.get("status");
    const query = status ? { status } : {};
    const items = await SignalLedger.find(query).sort({ signalDate: -1 }).limit(200).lean();
    const closed = items.filter((item) => item.status !== "OPEN");
    const wins = closed.filter((item) => item.status === "TARGET1" || item.status === "TARGET2").length;
    return NextResponse.json({ items, stats: { closed: closed.length, wins, winRate: closed.length ? wins / closed.length : null } });
  } catch (error) {
    return NextResponse.json({ error: "Signal ledger unavailable", details: String(error) }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.symbol || !body.mode) return NextResponse.json({ error: "Symbol and mode required" }, { status: 400 });
    await connectDB();
    const item = await SignalLedger.findOneAndUpdate(
      { symbol: String(body.symbol).toUpperCase(), mode: body.mode, signalDate: body.signalDate ?? todayIST() },
      {
        $set: {
          entry: Number(body.entry),
          stopLoss: Number(body.stopLoss),
          target1: Number(body.target1),
          target2: Number(body.target2),
          quantScore: Number(body.quantScore),
          status: (body.status ?? "OPEN") as SignalStatus,
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return NextResponse.json({ item });
  } catch (error) {
    return NextResponse.json({ error: "Could not write signal ledger", details: String(error) }, { status: 503 });
  }
}
