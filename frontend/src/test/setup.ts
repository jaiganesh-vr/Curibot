// jsdom does not implement the modal <dialog> API that browsers provide.
// This stand-in only toggles the open state; focus trapping, inertness, and
// the top layer are browser behaviour and are not simulated here.
if (typeof HTMLDialogElement !== "undefined") {
    HTMLDialogElement.prototype.showModal ??= function showModal(
        this: HTMLDialogElement,
    ) {
        this.setAttribute("open", "");
    };

    HTMLDialogElement.prototype.close ??= function close(
        this: HTMLDialogElement,
    ) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
    };
}
