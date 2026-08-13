import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


port = os.environ.get("DASHBOARD_PREVIEW_PORT", "38766")
url = f"http://127.0.0.1:{port}"
artifact_dir = Path(os.environ.get("DASHBOARD_SCREENSHOT_DIR", r"C:\tmp"))
artifact_dir.mkdir(parents=True, exist_ok=True)

with sync_playwright() as playwright:
    browser_channel = os.environ.get("DASHBOARD_BROWSER_CHANNEL", "msedge")
    launch_options = {"headless": True}
    if browser_channel != "chromium":
        launch_options["channel"] = browser_channel
    browser = playwright.chromium.launch(**launch_options)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    console_errors = []
    failed_responses = []
    page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
    page.on("response", lambda response: failed_responses.append(f"{response.status} {response.url}") if response.status >= 400 else None)
    page.goto(url)
    page.wait_for_load_state("networkidle")

    expect(page.locator('[data-view-panel="settings"]')).to_be_visible()
    expect(page.locator("#page-title")).to_have_text("系统设置")
    expect(page.locator("#setup-guide-title")).to_have_text("完成两个必填项即可开始使用")
    expect(page.locator('[data-setup-step="eams"] em')).to_have_text("需要配置")
    expect(page.locator('[name="CHECK_INTERVAL_MINUTES"]')).to_have_value("5")
    expect(page.locator('[name="SMTP_HOST"]')).to_have_value("smtp.qq.com")
    expect(page.locator('[data-action="restart"]').first).to_be_disabled()
    page.locator('#settings-form button[type="submit"]').click()
    expect(page.locator(".toast").filter(has_text="配置尚未完成").last).to_be_visible()
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(250)
    page.screenshot(path=str(artifact_dir / "tju-dashboard-onboarding-empty.png"), full_page=True)

    mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
    mobile.goto(url)
    mobile.wait_for_load_state("networkidle")
    expect(mobile.locator('[data-view-panel="settings"]')).to_be_visible()
    expect(mobile.locator("#setup-guide-title")).to_have_text("完成两个必填项即可开始使用")
    expect(mobile.locator("#import-settings")).to_be_visible()
    mobile.screenshot(path=str(artifact_dir / "tju-dashboard-onboarding-mobile.png"), full_page=True)
    mobile.close()

    export_path = artifact_dir / "tju-auto-grade-settings-export.json"
    with page.expect_download() as download_info:
        page.locator("#export-settings").click()
    download_info.value.save_as(str(export_path))
    exported = json.loads(export_path.read_text(encoding="utf-8"))
    assert exported["format"] == "tju-auto-grade-settings"
    assert exported["settings"]["CHECK_INTERVAL_MINUTES"] == "5"
    assert "EAMS_PASSWORD" not in exported["settings"]
    assert "QQ_SMTP_CODE" not in exported["settings"]

    imported = {
        "format": "tju-auto-grade-settings",
        "version": 1,
        "settings": {
            "EAMS_USERNAME": "3025999999",
            "EAMS_PASSWORD": "must-not-import",
            "QQ_EMAIL": "student@qq.com",
            "NOTIFY_EMAIL": "receiver@example.com",
            "CHECK_INTERVAL_MINUTES": "7",
            "HEADLESS": "false",
        },
    }
    page.locator("#settings-import-file").set_input_files({
        "name": "settings.json",
        "mimeType": "application/json",
        "buffer": json.dumps(imported).encode("utf-8"),
    })
    expect(page.locator('[name="EAMS_USERNAME"]')).to_have_value("3025999999")
    expect(page.locator('[name="EAMS_PASSWORD"]')).to_have_value("")
    expect(page.locator('[name="CHECK_INTERVAL_MINUTES"]')).to_have_value("7")
    page.locator('[name="EAMS_PASSWORD"]').fill("test-password")
    page.locator('[name="QQ_SMTP_CODE"]').fill("test-mail-code")
    page.locator('#settings-form button[type="submit"]').click()

    expect(page.locator(".toast").filter(has_text="设置已保存").last).to_be_visible()
    expect(page.locator("#setup-guide")).to_have_class("setup-guide is-complete")
    expect(page.locator('[data-setup-step="eams"] em')).to_have_text("已完成")
    expect(page.locator('[data-setup-step="mail"] em')).to_have_text("已完成")
    expect(page.locator('[data-action="test-email"]').last).to_be_enabled()
    page.locator('[data-action="test-email"]').last.click()
    expect(page.locator(".toast").filter(has_text="测试邮件已发送").last).to_be_visible()
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(250)
    page.screenshot(path=str(artifact_dir / "tju-dashboard-onboarding.png"), full_page=True)

    assert not failed_responses, f"Failed responses: {failed_responses}"
    assert not console_errors, f"Browser console errors: {console_errors}"
    browser.close()

print("dashboard-onboarding-ui-ok")
