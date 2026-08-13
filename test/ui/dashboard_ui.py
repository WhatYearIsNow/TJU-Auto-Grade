import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


port = os.environ.get("DASHBOARD_PREVIEW_PORT", "38765")
url = f"http://127.0.0.1:{port}"
screenshot_dir = Path(os.environ.get("DASHBOARD_SCREENSHOT_DIR", r"C:\tmp"))
screenshot_dir.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser_channel = os.environ.get("DASHBOARD_BROWSER_CHANNEL", "msedge")
    launch_options = {"headless": True}
    if browser_channel != "chromium":
        launch_options["channel"] = browser_channel
    browser = playwright.chromium.launch(**launch_options)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    console_errors = []
    failed_responses = []
    page.on("console", lambda message: console_errors.append(f"{message.text} @ {message.location}") if message.type == "error" else None)
    page.on("response", lambda response: failed_responses.append(f"{response.status} {response.url}") if response.status >= 400 else None)
    page.goto(url)
    page.wait_for_load_state("networkidle")

    expect(page).to_have_title("TJU Auto Grade · 本机控制台")
    expect(page.locator("#overview-heading")).to_have_text("监控运行正常")
    expect(page.locator("#metric-grades")).to_have_text("4")
    expect(page.locator("#recent-grades .compact-grade")).to_have_count(4)
    page.screenshot(path=str(screenshot_dir / "tju-dashboard-overview.png"), full_page=True)

    action_checks = [
        ('[data-action="check"]', "查分完成"),
        ('[data-action="restart"]', "监控正在重启"),
        ('[data-action="stop"]', "监控已停止"),
        ('[data-action="retry-notifications"]', "通知队列已处理"),
        ('[data-action="test-email"]', "测试邮件已发送"),
    ]
    for selector, toast_text in action_checks:
        page.locator(selector).first.click()
        expect(page.locator(".toast").filter(has_text=toast_text).last).to_be_visible()

    page.get_by_role("button", name="成绩中心").click()
    expect(page.locator("#grades-table-body tr")).to_have_count(4)
    expect(page.locator("#semester-query-select option")).to_have_count(8)
    expect(page.locator("#semester-query-select option").filter(has_text="2024-2025 1")).to_have_count(1)
    expect(page.locator("#semester-query-select")).not_to_contain_text("当前")
    expect(page.locator("#toggle-older-semesters")).to_have_text("显示更早学期（2）")
    page.screenshot(path=str(screenshot_dir / "tju-dashboard-semesters.png"), full_page=True)
    page.locator("#toggle-older-semesters").click()
    expect(page.locator("#semester-query-select option")).to_have_count(10)
    expect(page.locator("#toggle-older-semesters")).to_have_attribute("aria-expanded", "true")
    page.locator("#toggle-older-semesters").click()
    expect(page.locator("#semester-query-select option")).to_have_count(8)
    page.locator("#semester-query-select").select_option("114")
    page.locator("#query-semester").click()
    expect(page.locator("#grade-source-label")).to_have_text("历史学期：2024-2025 1")
    expect(page.locator("#grades-table-body tr")).to_have_count(2)
    expect(page.locator("#grades-table-body")).to_contain_text("历史学期课程一")
    page.locator("#show-current-grades").click()
    expect(page.locator("#grade-source-label")).to_have_text("监控成绩快照")
    expect(page.locator("#grades-table-body tr")).to_have_count(4)
    page.locator("#grade-search").fill("数据结构")
    expect(page.locator("#grades-table-body tr")).to_have_count(1)
    expect(page.locator("#grades-table-body")).to_contain_text("数据结构")
    page.locator("#grade-search").fill("")

    page.get_by_role("button", name="查询总加权").click()
    expect(page.locator("#weighted-result")).to_contain_text("平均绩点：3.82")

    page.get_by_role("button", name="通知记录").click()
    expect(page.locator("#notification-list .notification-item")).to_have_count(2)
    expect(page.locator("#notification-pending")).to_have_text("1")

    page.get_by_role("button", name="运行日志").click()
    expect(page.locator("#log-lines")).to_contain_text("隔离环境日志读取正常")
    page.locator("#refresh-logs").click()

    page.get_by_role("button", name="系统设置").click()
    expect(page.locator("#configured-EAMS_PASSWORD")).to_have_text("已配置")
    expect(page.locator("#configured-QQ_SMTP_CODE")).to_have_text("已配置")
    page.locator('[name="CHECK_INTERVAL_MINUTES"]').fill("6")
    page.locator('#settings-form button[type="submit"]').click()
    expect(page.locator(".toast").filter(has_text="设置已保存").last).to_be_visible()
    page.screenshot(path=str(screenshot_dir / "tju-dashboard-desktop.png"), full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    mobile.goto(url)
    mobile.wait_for_load_state("networkidle")
    mobile.locator("#menu-button").click()
    expect(mobile.locator("#sidebar")).to_have_class("sidebar is-open")
    expect(mobile.get_by_role("button", name="成绩中心")).to_be_visible()
    mobile.wait_for_timeout(250)
    mobile.screenshot(path=str(screenshot_dir / "tju-dashboard-mobile.png"), full_page=True)
    mobile.close()

    assert not failed_responses, f"Failed responses: {failed_responses}"
    assert not console_errors, f"Browser console errors: {console_errors}"
    browser.close()

print("dashboard-ui-ok")
