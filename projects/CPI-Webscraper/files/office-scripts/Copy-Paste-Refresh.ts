/**
 * SHEET COPY-PASTE RESET
 *
 * Purpose:
 * Copies the entire USED RANGE of specified worksheets and pastes
 * it directly back over itself.
 *
 * This does NOT intentionally change the worksheet's data.
 * It re-applies the existing cells, formulas, and formatting and then
 * performs a full workbook calculation rebuild.
 *
 * The script is designed to be assigned to an Office Script button.
 */

function main(workbook: ExcelScript.Workbook): string {

    // ============================================================
    // USER SETTINGS
    // ============================================================

    /**
     * NUMBER OF SHEETS TO APPLY THE RESET TO
     *
     * Examples:
     * 1 = process the first sheet name below
     * 2 = process the first 2 sheet names below
     * 3 = process the first 3 sheet names below
     * etc.
     */
    const numberOfSheetsToApply: number = 1;


    /**
     * SHEET NAMES
     *
     * Enter worksheet names between the quotation marks.
     * Separate each worksheet name with a comma.
     *
     * Example:
     * "Day 1,Day 2,Day 3"
     */
    const sheetNames: string = "CPI_Downloader";


    // ============================================================
    // END OF USER SETTINGS
    // Normally, nothing below this line needs to be edited.
    // ============================================================


    const logMessages: string[] = [];

    let requestedSheetCount = Math.floor(numberOfSheetsToApply);

    // Prevent negative values.
    if (requestedSheetCount < 0) {
        requestedSheetCount = 0;
    }


    // Split the comma-separated list and:
    // - trim accidental spaces
    // - remove blank entries
    const enteredSheetNames: string[] = sheetNames
        .split(",")
        .map(name => name.trim())
        .filter(name => name.length > 0);


    // ------------------------------------------------------------
    // VALIDATE NUMBER OF SHEETS REQUESTED
    // ------------------------------------------------------------

    if (requestedSheetCount === 0) {
        const message =
            "No worksheets were processed because " +
            "numberOfSheetsToApply is set to 0.";

        console.log(message);
        return message;
    }


    // ------------------------------------------------------------
    // VALIDATE NUMBER OF SHEET NAMES ENTERED
    // ------------------------------------------------------------

    if (enteredSheetNames.length < requestedSheetCount) {

        const missingCount =
            requestedSheetCount - enteredSheetNames.length;

        logMessages.push(
            `NOTICE: The script was configured to process ` +
            `${requestedSheetCount} worksheet(s), but only ` +
            `${enteredSheetNames.length} worksheet name(s) were entered. ` +
            `${missingCount} additional worksheet name(s) were not supplied, ` +
            `so only the entered worksheets will be processed.`
        );
    }


    if (enteredSheetNames.length > requestedSheetCount) {

        const ignoredCount =
            enteredSheetNames.length - requestedSheetCount;

        logMessages.push(
            `NOTICE: ${enteredSheetNames.length} worksheet name(s) were entered, ` +
            `but numberOfSheetsToApply is set to ${requestedSheetCount}. ` +
            `Only the first ${requestedSheetCount} worksheet(s) will be processed. ` +
            `${ignoredCount} additional worksheet name(s) will be ignored.`
        );
    }


    // Only process as many sheet names as requested.
    const sheetsToProcess: string[] =
        enteredSheetNames.slice(0, requestedSheetCount);


    // ------------------------------------------------------------
    // PROCESS EACH WORKSHEET
    // ------------------------------------------------------------

    let successfulSheets = 0;
    let skippedSheets = 0;

    for (const sheetName of sheetsToProcess) {

        const sheet = workbook.getWorksheet(sheetName);


        // --------------------------------------------------------
        // SHEET DOES NOT EXIST
        // --------------------------------------------------------

        if (!sheet) {

            logMessages.push(
                `SKIPPED: Worksheet "${sheetName}" could not be found ` +
                `in this workbook.`
            );

            skippedSheets++;

            continue;
        }


        // --------------------------------------------------------
        // GET THE WORKSHEET'S USED RANGE
        // --------------------------------------------------------

        const usedRange = sheet.getUsedRange();


        // --------------------------------------------------------
        // SHEET IS COMPLETELY BLANK
        // --------------------------------------------------------

        if (!usedRange) {

            logMessages.push(
                `SKIPPED: Worksheet "${sheetName}" is blank and has ` +
                `no used range to copy and paste.`
            );

            skippedSheets++;

            continue;
        }


        // Record the range address for the final log.
        const rangeAddress = usedRange.getAddress();


        // --------------------------------------------------------
        // COPY + PASTE THE RANGE DIRECTLY BACK OVER ITSELF
        // --------------------------------------------------------
        //
        // RangeCopyType.all copies:
        // - values
        // - formulas
        // - formatting
        //
        // This behaves similarly to copying the used cells in Excel
        // and immediately pasting them back over the same cells.
        //
        usedRange.copyFrom(
            usedRange,
            ExcelScript.RangeCopyType.all,
            false,
            false
        );


        // Recalculate the worksheet's used range.
        usedRange.calculate();


        // Record successful processing.
        successfulSheets++;

        logMessages.push(
            `SUCCESS: "${sheetName}" was reset by copying and pasting ` +
            `its used range (${rangeAddress}) back over itself.`
        );
    }


    // ------------------------------------------------------------
    // FULL WORKBOOK RECALCULATION
    // ------------------------------------------------------------
    //
    // After all requested sheets have been processed, perform a
    // full dependency-tree rebuild and workbook recalculation.
    //
    workbook
        .getApplication()
        .calculate(ExcelScript.CalculationType.fullRebuild);


    logMessages.push(
        "Full workbook calculation rebuild completed."
    );


    // ------------------------------------------------------------
    // FINAL RESULT
    // ------------------------------------------------------------

    const finalMessage =
        `Sheet Reset Complete — ` +
        `${successfulSheets} worksheet(s) processed successfully, ` +
        `${skippedSheets} worksheet(s) skipped.`;

    logMessages.push(finalMessage);


    // ------------------------------------------------------------
    // OUTPUT LOG
    // ------------------------------------------------------------
    //
    // Build the entire log first and write it to the console only
    // once. This avoids Office Scripts performance warnings caused
    // by console.log() calls inside loops.
    //
    const fullLog = logMessages.join("\n");

    console.log(fullLog);

    return fullLog;
}