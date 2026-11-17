# Windows exposes a non-consuming console peek. Leave type-ahead in the
# original console queue for Claude, including Esc and every later paste byte.
param([int]$Guard, [int]$Quiet, [int]$Timeout)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class QuestionConsole {
    [StructLayout(LayoutKind.Explicit, Size = 20)]
    struct Record {
        [FieldOffset(0)] public ushort Kind;
        [FieldOffset(4)] public int Down;
        [FieldOffset(8)] public ushort Repeat;
        [FieldOffset(14)] public ushort Char;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", EntryPoint="PeekConsoleInputW", ExactSpelling=true)]
    static extern bool Peek(IntPtr input, [Out] Record[] records, uint size, out uint count);
    [DllImport("kernel32.dll", EntryPoint="ReadConsoleInputW", ExactSpelling=true)]
    static extern bool Read(IntPtr input, [Out] Record[] records, uint size, out uint count);

    // Exit 70 leaves queued input for Claude. Choice receipts use 81 through 86
    // so a PowerShell startup or compilation error (exit 1) cannot send an answer.
    const int Queued = 70;
    public static int Ask(string question, int guard, int quiet, int timeout) {
        IntPtr input = GetStdHandle(-10);
        Record[] records = new Record[128];
        Stopwatch clock = Stopwatch.StartNew();
        bool visible = false;
        long candidateAt = -1;
        try {
            while (true) {
                uint count;
                if (!Peek(input, records, (uint)records.Length, out count)) return 0;
                if (count == records.Length) return Queued;
                int first = -1;
                for (int i = 0; i < count; i++) {
                    if (records[i].Kind != 1 || records[i].Down == 0) continue;
                    if (!visible || first >= 0 || records[i].Repeat != 1) return Queued;
                    first = i;
                }
                if (first >= 0) {
                    int key = records[first].Char;
                    bool digit = key >= '1' && key <= '6';
                    if (!digit && key != 13 && key != 10 && key != 3) return Queued;
                    if (candidateAt < 0) candidateAt = clock.ElapsedMilliseconds;
                    if (!digit || clock.ElapsedMilliseconds - candidateAt >= quiet) {
                        uint used;
                        if (!Read(input, records, (uint)first + 1, out used)) return 0;
                        return digit ? 80 + key - '0' : key == 3 ? 130 : 0;
                    }
                } else if (count > 0) {
                    // Only non-key records (e.g. focus events and key releases).
                    uint used;
                    if (!Read(input, records, count, out used)) return 0;
                } else if (!visible && clock.ElapsedMilliseconds >= guard) {
                    Console.Write(question);
                    visible = true;
                    clock.Restart();
                }
                if (visible && clock.ElapsedMilliseconds >= timeout) return 0;
                Thread.Sleep(8);
            }
        } finally {
            if (visible) Console.WriteLine();
        }
    }
}
'@
exit [QuestionConsole]::Ask($env:CCC_QUESTION_TEXT, $Guard, $Quiet, $Timeout)
