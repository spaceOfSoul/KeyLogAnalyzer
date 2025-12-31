#define UNICODE
#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <shlobj.h>
#include <atomic>
#include <stdint.h>
#include <string>
#include <strsafe.h>

#pragma comment(lib, "Shlwapi.lib")

static const wchar_t* kWndClass = L"WinKeyCollectorHiddenWindow";
static const wchar_t* kRunKey = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
static const wchar_t* kRunName = L"WinKeyCollector";
static const UINT WMAPP_TRAY = WM_APP + 1;

static HHOOK g_hHook = nullptr;
static HWND  g_hWnd = nullptr;
static NOTIFYICONDATA nid = { 0 };

LRESULT CALLBACK WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

// ------------------------------
// Logging
// ------------------------------
struct KeyLogEvent
{
    FILETIME ft;
    LARGE_INTEGER qpc;
    DWORD qpcFreq;
    DWORD hookTimeMs;

    DWORD msg;
    DWORD vk;
    DWORD scan;
    DWORD flags;
    DWORD extraInfoLow;
    DWORD injected;
    DWORD blocked;

    wchar_t keyName[64];
};


static HANDLE g_logThread = nullptr;
static HANDLE g_logEvent = nullptr;
static HANDLE g_stopEvent = nullptr;

static HANDLE g_dumpEvent = nullptr;
static std::atomic<uint32_t> g_dumpSeconds{ 0 };

static std::atomic<uint64_t> g_wr{ 0 };
static std::atomic<uint64_t> g_rd{ 0 };

static constexpr uint32_t kRingPow2 = 8192;
static constexpr uint32_t kRingMask = kRingPow2 - 1;
static KeyLogEvent g_ring[kRingPow2];

static std::atomic<uint64_t> g_dropped{ 0 };

// 현재 로그 파일 경로(로거 스레드에서 설정)
static wchar_t g_logPathW[1024] = { 0 };

static bool EnsureDirExists(const wchar_t* dir)
{
    if (!dir || !dir[0]) return false;
    int rc = SHCreateDirectoryExW(nullptr, dir, nullptr);
    return (rc == ERROR_SUCCESS || rc == ERROR_FILE_EXISTS || rc == ERROR_ALREADY_EXISTS);
}

static bool BuildLogFilePath(wchar_t* outPath, DWORD cchOut)
{
    if (!outPath || cchOut == 0) return false;

    PWSTR localAppData = nullptr;
    HRESULT hr = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData);
    if (FAILED(hr) || !localAppData) return false;

    wchar_t dir[MAX_PATH] = { 0 };
    wsprintfW(dir, L"%s\\WinKeyCollector\\logs", localAppData);
    CoTaskMemFree(localAppData);

    if (!EnsureDirExists(dir)) return false;

    SYSTEMTIME st;
    GetLocalTime(&st);

    wsprintfW(outPath, L"%s\\log_%04u%02u%02u_%02u%02u%02u.csv",
        dir, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    return true;
}

static bool BuildViewFilePath(wchar_t* outPath, DWORD cchOut, uint32_t seconds)
{
    if (!outPath || cchOut == 0) return false;

    PWSTR localAppData = nullptr;
    HRESULT hr = SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData);
    if (FAILED(hr) || !localAppData) return false;

    wchar_t dir[MAX_PATH] = { 0 };
    wsprintfW(dir, L"%s\\WinKeyCollector\\logs", localAppData);
    CoTaskMemFree(localAppData);

    if (!EnsureDirExists(dir)) return false;

    SYSTEMTIME st;
    GetLocalTime(&st);

    // view_last1h_YYYYMMDD_HHMMSS.csv (seconds는 현재 3600만 사용)
    wsprintfW(outPath, L"%s\\view_last%us_%04u%02u%02u_%02u%02u%02u.csv",
        dir, seconds, st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    return true;
}

static void WriteCsvHeader(HANDLE hFile)
{
    const char* hdr =
        "local_time,utc_filetime_100ns,qpc,qpc_freq,hook_time_ms,"
        "msg,vk,scan,flags,key_name,injected,blocked,extraInfoLow,dropped_total\n";
    DWORD written = 0;
    WriteFile(hFile, hdr, (DWORD)lstrlenA(hdr), &written, nullptr);
}


static void FileTimeToLocalIso8601(const FILETIME& ftUtc, char* out, size_t outCch)
{
    if (!out || outCch == 0) return;

    FILETIME ftLocal;
    SYSTEMTIME stUtc, stLocal;

    FileTimeToSystemTime(&ftUtc, &stUtc);
    SystemTimeToFileTime(&stUtc, &ftLocal);
    FileTimeToLocalFileTime(&ftLocal, &ftLocal);
    FileTimeToSystemTime(&ftLocal, &stLocal);

    wsprintfA(out, "%04u-%02u-%02u %02u:%02u:%02u.%03u",
        stLocal.wYear, stLocal.wMonth, stLocal.wDay,
        stLocal.wHour, stLocal.wMinute, stLocal.wSecond, stLocal.wMilliseconds);
}

static void BuildKeyName(const KBDLLHOOKSTRUCT* p, wchar_t* out, size_t outCch)
{
    if (!out || outCch == 0) return;
    out[0] = L'\0';
    if (!p) return;

    LONG lParam = (LONG)(p->scanCode << 16);
    if (p->flags & LLKHF_EXTENDED) lParam |= (1 << 24);

    if (GetKeyNameTextW(lParam, out, (int)outCch) <= 0) {
        UINT sc = MapVirtualKeyW(p->vkCode, MAPVK_VK_TO_VSC);
        LONG lp2 = (LONG)(sc << 16);
        if (p->flags & LLKHF_EXTENDED) lp2 |= (1 << 24);
        GetKeyNameTextW(lp2, out, (int)outCch);
    }

    // 그래도 비면 최소한 VK코드라도 남김
    if (out[0] == L'\0') {
        wsprintfW(out, L"VK_%02X", (unsigned)p->vkCode);
    }
}

static int WideToUtf8(const wchar_t* w, char* out, int outCch)
{
    if (!out || outCch <= 0) return 0;
    out[0] = 0;
    if (!w) return 0;
    return WideCharToMultiByte(CP_UTF8, 0, w, -1, out, outCch, nullptr, nullptr);
}

static uint64_t FileTimeNow100nsUTC()
{
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER ui;
    ui.LowPart = ft.dwLowDateTime;
    ui.HighPart = ft.dwHighDateTime;
    return ui.QuadPart;
}

// src CSV에서 "utc_filetime_100ns" (2번째 컬럼) 파싱해서 cutoff 이후만 dst로 복사
static bool DumpLastSeconds(const wchar_t* srcPath, uint32_t seconds, wchar_t* outViewPath, DWORD outCch)
{
    if (!srcPath || !srcPath[0] || seconds == 0) return false;
    if (!BuildViewFilePath(outViewPath, outCch, seconds)) return false;

    HANDLE hSrc = CreateFileW(srcPath, GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hSrc == INVALID_HANDLE_VALUE) return false;

    HANDLE hDst = CreateFileW(outViewPath, GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hDst == INVALID_HANDLE_VALUE) {
        CloseHandle(hSrc);
        return false;
    }

    // cutoff 계산: FILETIME(100ns)에서 seconds*10,000,000 빼기
    const uint64_t now = FileTimeNow100nsUTC();
    const uint64_t delta = (uint64_t)seconds * 10000000ULL;
    const uint64_t cutoff = (now > delta) ? (now - delta) : 0;

    // 간단 line reader(UTF-8/ASCII 가정: 현재 로거는 ANSI로만 작성)
    // 큰 파일 고려: chunk 기반 스트리밍
    const DWORD BUF = 1 << 16;
    char buf[BUF];
    DWORD rd = 0;

    // 헤더는 항상 복사
    // 첫 줄(헤더)만 확보해서 dst로 기록하고 이후부터 필터
    std::string carry;
    bool headerDone = false;

    auto write_line = [&](const char* s, size_t n) {
        DWORD wr = 0;
        WriteFile(hDst, s, (DWORD)n, &wr, nullptr);
        };

    auto process_line = [&](const std::string& line) {
        if (!headerDone) {
            write_line(line.c_str(), line.size());
            write_line("\n", 1);
            headerDone = true;
            return;
        }

        // CSV: local_time,utc_filetime_100ns,...
        // 두 번째 컬럼 숫자만 파싱
        // 1) 첫 콤마 찾기 -> 2) 두 번째 콤마 찾기 -> [a,b) 숫자 영역
        size_t c1 = line.find(',');
        if (c1 == std::string::npos) return;
        size_t c2 = line.find(',', c1 + 1);
        if (c2 == std::string::npos) return;

        uint64_t ft100 = 0;
        for (size_t i = c1 + 1; i < c2; i++) {
            char ch = line[i];
            if (ch < '0' || ch > '9') { ft100 = 0; break; }
            ft100 = ft100 * 10ULL + (uint64_t)(ch - '0');
        }

        if (ft100 >= cutoff) {
            write_line(line.c_str(), line.size());
            write_line("\n", 1);
        }
        };

    while (ReadFile(hSrc, buf, BUF, &rd, nullptr) && rd > 0) {
        carry.append(buf, buf + rd);

        // line split by '\n'
        size_t pos = 0;
        for (;;) {
            size_t nl = carry.find('\n', pos);
            if (nl == std::string::npos) {
                carry.erase(0, pos);
                break;
            }
            std::string line = carry.substr(pos, nl - pos);
            // CR 제거
            if (!line.empty() && line.back() == '\r') line.pop_back();
            process_line(line);
            pos = nl + 1;
        }
    }

    CloseHandle(hDst);
    CloseHandle(hSrc);
    return true;
}

static DWORD WINAPI LogThreadProc(LPVOID)
{
    HRESULT hrCo = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    wchar_t pathW[1024] = { 0 };
    if (!BuildLogFilePath(pathW, ARRAYSIZE(pathW))) {
        return 0;
    }

    lstrcpynW(g_logPathW, pathW, ARRAYSIZE(g_logPathW));

    HANDLE hFile = CreateFileW(pathW, GENERIC_WRITE, FILE_SHARE_READ,
        nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) {
        return 0;
    }
    //
    WriteCsvHeader(hFile);

    HANDLE waits[3] = { g_stopEvent, g_logEvent, g_dumpEvent };

    char line[2048];

    for (;;)
    {
        DWORD wr = WaitForMultipleObjects(3, waits, FALSE, 1000);
        if (wr == WAIT_OBJECT_0) break; // stop

        // dump 요청 처리(로그 파일 flush 후 snapshot)
        if (wr == WAIT_OBJECT_0 + 2) {
            uint32_t sec = g_dumpSeconds.exchange(0, std::memory_order_acq_rel);
            if (sec != 0 && g_logPathW[0]) {
                FlushFileBuffers(hFile);

                wchar_t viewPath[1024] = { 0 };
                if (DumpLastSeconds(g_logPathW, sec, viewPath, ARRAYSIZE(viewPath))) {
                    // 생성한 파일 열기(기본 앱)
                    ShellExecuteW(nullptr, L"open", viewPath, nullptr, nullptr, SW_SHOWNORMAL);
                }
            }
        }

        // consume ring
        uint64_t r = g_rd.load(std::memory_order_relaxed);
        uint64_t w = g_wr.load(std::memory_order_acquire);

        if (w - r > kRingPow2) {
            uint64_t newR = w - kRingPow2;
            g_dropped.fetch_add(newR - r, std::memory_order_relaxed);
            r = newR;
            g_rd.store(r, std::memory_order_relaxed);
        }

        while (r < w)
        {
            const KeyLogEvent& e = g_ring[(uint32_t)(r & kRingMask)];

            char localTime[64] = { 0 };
            FileTimeToLocalIso8601(e.ft, localTime, sizeof(localTime));

            ULARGE_INTEGER ui;
            ui.LowPart = e.ft.dwLowDateTime;
            ui.HighPart = e.ft.dwHighDateTime;

            uint64_t droppedTotal = g_dropped.load(std::memory_order_relaxed);

            char keyUtf8[256] = { 0 };
            WideToUtf8(e.keyName, keyUtf8, (int)sizeof(keyUtf8));

            char keyEsc[512] = { 0 };
            {
                size_t o = 0;
                keyEsc[o++] = '"';
                for (size_t i = 0; keyUtf8[i] && o + 2 < sizeof(keyEsc); i++) {
                    if (keyUtf8[i] == '"') {
                        keyEsc[o++] = '"';
                        keyEsc[o++] = '"';
                    }
                    else {
                        keyEsc[o++] = keyUtf8[i];
                    }
                }
                if (o + 2 < sizeof(keyEsc)) keyEsc[o++] = '"';
                keyEsc[o] = 0;
            }


            HRESULT hr = StringCchPrintfA(
                line, ARRAYSIZE(line),
                "%s,%llu,%lld,%lu,%lu,%lu,%lu,%lu,%lu,%s,%lu,%lu,%lu,%llu\n",
                localTime,
                (unsigned long long)ui.QuadPart,
                (long long)e.qpc.QuadPart,
                (unsigned long)e.qpcFreq,
                (unsigned long)e.hookTimeMs,
                (unsigned long)e.msg,
                (unsigned long)e.vk,
                (unsigned long)e.scan,
                (unsigned long)e.flags,
                keyEsc,
                (unsigned long)e.injected,
                (unsigned long)e.blocked,
                (unsigned long)e.extraInfoLow,
                (unsigned long long)droppedTotal
            );

            if (FAILED(hr)) {
                // 버퍼 부족/포맷 오류면 해당 레코드 스킵
                r++;
                continue;
            }

            DWORD written = 0;
            WriteFile(hFile, line, (DWORD)lstrlenA(line), &written, nullptr);
            r++;
        }

        g_rd.store(r, std::memory_order_release);
    }

    FlushFileBuffers(hFile);
    CloseHandle(hFile);

    if (SUCCEEDED(hrCo)) CoUninitialize();
    return 0;
}

static void PushLogEvent(const KBDLLHOOKSTRUCT* p, DWORD msg, DWORD blocked)
{
    if (!p) return;

    KeyLogEvent e = {};
    GetSystemTimeAsFileTime(&e.ft);

    LARGE_INTEGER qpc;
    QueryPerformanceCounter(&qpc);
    e.qpc = qpc;

    LARGE_INTEGER fq;
    QueryPerformanceFrequency(&fq);
    e.qpcFreq = (DWORD)fq.QuadPart;

    e.hookTimeMs = p->time;
    e.msg = msg;
    e.vk = p->vkCode;
    e.scan = p->scanCode;
    e.flags = p->flags;
    e.extraInfoLow = (DWORD)(uintptr_t)p->dwExtraInfo;
    e.injected = (p->flags & LLKHF_INJECTED) ? 1u : 0u;
    e.blocked = blocked;

    BuildKeyName(p, e.keyName, ARRAYSIZE(e.keyName));

    uint64_t idx = g_wr.load(std::memory_order_relaxed);

    g_ring[(uint32_t)(idx & kRingMask)] = e;

    g_wr.store(idx + 1, std::memory_order_release);

    if (g_logEvent) SetEvent(g_logEvent);
}



// ------------------------------
// Autostart
// ------------------------------
static bool GetSelfPath(wchar_t* buf, DWORD cch) {
    DWORD n = GetModuleFileNameW(nullptr, buf, cch);
    return (n > 0 && n < cch);
}

static bool IsAutoStartRegistered() {
    HKEY hKey = nullptr;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, kRunKey, 0, KEY_READ, &hKey) != ERROR_SUCCESS) {
        return false;
    }
    wchar_t val[32768] = { 0 };
    DWORD type = 0, cb = sizeof(val);
    LONG rc = RegGetValueW(hKey, nullptr, kRunName, RRF_RT_REG_SZ, &type, val, &cb);
    RegCloseKey(hKey);
    if (rc != ERROR_SUCCESS || type != REG_SZ) return false;

    wchar_t self[32768] = { 0 };
    if (!GetSelfPath(self, ARRAYSIZE(self))) return false;

    wchar_t* p = val;
    size_t len = wcslen(val);
    if (len >= 2 && val[0] == L'\"' && val[len - 1] == L'\"') {
        val[len - 1] = L'\0';
        p = val + 1;
    }

    int cmp = CompareStringOrdinal(self, -1, p, -1, TRUE);
    return (cmp == CSTR_EQUAL);
}

static void EnsureAutoStart() {
    if (IsAutoStartRegistered()) return;

    wchar_t self[32768] = { 0 };
    if (!GetSelfPath(self, ARRAYSIZE(self))) return;

    wchar_t quoted[32768] = { 0 };
    wsprintfW(quoted, L"\"%s\"", self);

    HKEY hKey = nullptr;
    if (RegCreateKeyExW(HKEY_CURRENT_USER, kRunKey, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &hKey, nullptr) == ERROR_SUCCESS) {
        RegSetValueExW(hKey, kRunName, 0, REG_SZ,
            reinterpret_cast<const BYTE*>(quoted),
            (DWORD)((wcslen(quoted) + 1) * sizeof(wchar_t)));
        RegCloseKey(hKey);
    }
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam)
{
    if (nCode == HC_ACTION) {
        const KBDLLHOOKSTRUCT* p = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
        if (p) {
            PushLogEvent(p, (DWORD)wParam, 0);
        }
    }
    return CallNextHookEx(g_hHook, nCode, wParam, lParam);
}

// ------------------------------
// Tray
// ------------------------------
void ShowTrayMenu(HWND hWnd)
{
    POINT pt;
    GetCursorPos(&pt);

    HMENU hMenu = CreatePopupMenu();
    if (!hMenu) return;

    AppendMenuW(hMenu, MF_STRING, 2001, L"로그 조회");
    AppendMenuW(hMenu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(hMenu, MF_STRING, 2002, L"종료");

    SetForegroundWindow(hWnd);
    TrackPopupMenu(hMenu, TPM_BOTTOMALIGN | TPM_LEFTALIGN, pt.x, pt.y, 0, hWnd, nullptr);
    DestroyMenu(hMenu);
}

bool AddTrayIcon(HWND hWnd)
{
    nid.cbSize = sizeof(nid);
    nid.hWnd = hWnd;
    nid.uID = 1;
    nid.uFlags = NIF_MESSAGE | NIF_TIP | NIF_ICON;
    nid.uCallbackMessage = WMAPP_TRAY;
    nid.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
    lstrcpynW(nid.szTip, L"키 입력 로깅 동작 중", ARRAYSIZE(nid.szTip));
    return Shell_NotifyIconW(NIM_ADD, &nid) == TRUE;
}

void RemoveTrayIcon()
{
    if (nid.cbSize) Shell_NotifyIconW(NIM_DELETE, &nid);
    if (nid.hIcon) { DestroyIcon(nid.hIcon); nid.hIcon = nullptr; }
}

// ------------------------------
// Entry
// ------------------------------
int APIENTRY wWinMain(HINSTANCE hInst, HINSTANCE, LPWSTR, int)
{
    HRESULT hrCo = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    EnsureAutoStart();

    g_logEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr); // auto-reset
    g_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr); // manual-reset
    g_dumpEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr); // auto-reset

    if (g_logEvent && g_stopEvent && g_dumpEvent) {
        g_logThread = CreateThread(nullptr, 0, LogThreadProc, nullptr, 0, nullptr);
    }

    WNDCLASSEX wc = { sizeof(WNDCLASSEX) };
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInst;
    wc.lpszClassName = kWndClass;
    RegisterClassExW(&wc);

    g_hWnd = CreateWindowExW(0, kWndClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, hInst, nullptr);
    if (!g_hWnd) return 1;

    if (!AddTrayIcon(g_hWnd)) {
        DestroyWindow(g_hWnd);
        return 1;
    }

    g_hHook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, nullptr, 0);
    if (!g_hHook) {
        RemoveTrayIcon();
        DestroyWindow(g_hWnd);
        return 1;
    }

    MSG msg;
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_hHook) { UnhookWindowsHookEx(g_hHook); g_hHook = nullptr; }

    if (g_stopEvent) SetEvent(g_stopEvent);
    if (g_logThread) {
        WaitForSingleObject(g_logThread, 2000);
        CloseHandle(g_logThread);
        g_logThread = nullptr;
    }

    if (g_logEvent) { CloseHandle(g_logEvent);  g_logEvent = nullptr; }
    if (g_dumpEvent) { CloseHandle(g_dumpEvent); g_dumpEvent = nullptr; }
    if (g_stopEvent) { CloseHandle(g_stopEvent); g_stopEvent = nullptr; }

    RemoveTrayIcon();

    if (SUCCEEDED(hrCo)) CoUninitialize();
    return 0;
}

LRESULT CALLBACK WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam)
{
    switch (msg)
    {
    case WMAPP_TRAY:
        if (LOWORD(lParam) == WM_RBUTTONUP) {
            ShowTrayMenu(hWnd);
        }
        return 0;

    case WM_COMMAND:
        if (LOWORD(wParam) == 2001) {
            g_dumpSeconds.store(3600, std::memory_order_release);
            if (g_dumpEvent) SetEvent(g_dumpEvent);
        }
        else if (LOWORD(wParam) == 2002) {
            DestroyWindow(hWnd);
        }
        return 0;

    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;

    default:
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }
}
