import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Watchlist } from "@/lib/models/Watchlist";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const userId = req.nextUrl.searchParams.get("userId") ?? "local";
    const items = await Watchlist.find({ userId }).sort({ createdAt: -1 }).lean();
    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json({ error: "Watchlist storage unavailable", details: String(error) }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = String(body.symbol ?? "").toUpperCase();
    if (!symbol) return NextResponse.json({ error: "Symbol required" }, { status: 400 });
    await connectDB();
    const item = await Watchlist.findOneAndUpdate(
      { userId: body.userId ?? "local", symbol },
      { $set: {
        note: body.note ?? "",
        alertEnabled: body.alertEnabled !== false,
        zoneLow: body.zoneLow == null ? undefined : Number(body.zoneLow),
        zoneHigh: body.zoneHigh == null ? undefined : Number(body.zoneHigh),
      } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return NextResponse.json({ item });
  } catch (error) {
    return NextResponse.json({ error: "Could not save watchlist item", details: String(error) }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const symbol = String(req.nextUrl.searchParams.get("symbol") ?? "").toUpperCase();
    const userId = req.nextUrl.searchParams.get("userId") ?? "local";
    await connectDB();
    await Watchlist.deleteOne({ userId, symbol });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: "Could not remove watchlist item", details: String(error) }, { status: 503 });
  }
}
