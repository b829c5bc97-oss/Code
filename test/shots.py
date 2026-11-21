import asyncio, sys
from playwright.async_api import async_playwright

BASE = "http://localhost:8899"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/shots"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 1000})
        page = await ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto(BASE + "/")
        await page.wait_for_selector("form#auth-form")
        await page.screenshot(path=f"{OUT}/0-setup.png")
        await page.fill("input[name=code]", "123456")
        await page.fill("input[name=password]", "longpassword")
        await page.click("button[type=submit]")
        await page.wait_for_selector("text=All accounts")
        await page.wait_for_timeout(500)
        await page.screenshot(path=f"{OUT}/1-overview.png", full_page=True)
        for name, h in [("2-plan", "#/plan"), ("3-create", "#/create"), ("4-accounts", "#/accounts"), ("5-insights", "#/insights"), ("6-settings", "#/settings")]:
            await page.goto(BASE + "/" + h)
            await page.wait_for_timeout(900)
            if name == "3-create":
                await page.click("#c-accounts [data-acc]")
                await page.wait_for_timeout(900)
            await page.screenshot(path=f"{OUT}/{name}.png", full_page=True)
        mob = await b.new_context(viewport={"width": 390, "height": 844})
        mp = await mob.new_page()
        await mp.goto(BASE + "/")
        await mp.wait_for_timeout(500)
        await mp.fill("input[name=password]", "longpassword")
        await mp.click("button[type=submit]")
        await mp.wait_for_timeout(1200)
        await mp.goto(BASE + "/#/plan")
        await mp.wait_for_timeout(900)
        await mp.screenshot(path=f"{OUT}/7-mobile-plan.png", full_page=False)
        print("errors:", errs)
        await b.close()

asyncio.run(main())
