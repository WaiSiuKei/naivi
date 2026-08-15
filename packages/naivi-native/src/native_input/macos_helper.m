// macOS native text-input helper.
// Compiled via cc crate in build.rs with -fobjc-arc.
// All AppKit calls are wrapped in @try/@catch so ObjC exceptions never
// propagate through the Rust FFI boundary (chartles pattern).

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// ---------------------------------------------------------------------------
// Callbacks into Rust
// ---------------------------------------------------------------------------
typedef void (*value_changed_fn)(void *ctx, const char *text);
typedef void (*committed_fn)(void *ctx, const char *text);
typedef void (*submit_fn)(void *ctx);
typedef void (*tab_fn)(void *ctx, int shift);

// The handle: the control + the Rust callbacks/ctx.
typedef struct {
    __unsafe_unretained NSView *parent;
    NSView *control;          // NSTextField (single) or NSScrollView->NSTextView (multi)
    NSTextView *textView;     // non-nil for multiline
    int multiline;
    BOOL isProgrammatic;
    void *ctx;
    value_changed_fn on_value_changed;
    committed_fn on_committed;
    submit_fn on_submit;
    tab_fn on_tab;
} NativeInputHandle;

// AppKit uses a bottom-left origin; blitz reports top-left window coordinates,
// so the y is flipped by the parent view's height.
static double flip_y(NativeInputHandle *h, double y, double height) {
    double parent_h = h->parent != nil ? h->parent.bounds.size.height : 0.0;
    return parent_h - y - height;
}

static char *_textBuffer = NULL;
static void set_text_buffer(const char *text) {
    free(_textBuffer);
    _textBuffer = NULL;
    if (text != NULL) _textBuffer = strdup(text);
}

// ---------------------------------------------------------------------------
// Delegate (NSTextField and NSTextView)
// ---------------------------------------------------------------------------
@interface NativeInputDelegate : NSObject <NSTextFieldDelegate, NSTextViewDelegate>
@property(nonatomic, assign) NativeInputHandle *handle;
@end

@implementation NativeInputDelegate

- (void)controlTextDidChange:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->isProgrammatic || h->on_value_changed == NULL) return;
    @autoreleasepool {
        NSTextField *field = (NSTextField *)notification.object;
        const char *utf8 = field.stringValue.UTF8String;
        h->on_value_changed(h->ctx, utf8 != NULL ? utf8 : "");
    }
}

- (void)controlTextDidEndEditing:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->on_committed == NULL) return;
    @autoreleasepool {
        NSTextField *field = (NSTextField *)notification.object;
        const char *utf8 = field.stringValue.UTF8String;
        h->on_committed(h->ctx, utf8 != NULL ? utf8 : "");
    }
}

- (void)textDidChange:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->isProgrammatic || h->on_value_changed == NULL) return;
    @autoreleasepool {
        NSTextView *view = (NSTextView *)notification.object;
        const char *utf8 = view.string.UTF8String;
        h->on_value_changed(h->ctx, utf8 != NULL ? utf8 : "");
    }
}

- (void)textDidEndEditing:(NSNotification *)notification {
    NativeInputHandle *h = self.handle;
    if (h == NULL || h->on_committed == NULL) return;
    @autoreleasepool {
        NSTextView *view = (NSTextView *)notification.object;
        const char *utf8 = view.string.UTF8String;
        h->on_committed(h->ctx, utf8 != NULL ? utf8 : "");
    }
}

- (BOOL)handleCommandSelector:(SEL)commandSelector {
    NativeInputHandle *h = self.handle;
    if (h == NULL) return NO;
    if (commandSelector == @selector(insertTab:)) {
        if (h->on_tab) h->on_tab(h->ctx, 0);
        return YES;
    }
    if (commandSelector == @selector(insertBacktab:)) {
        if (h->on_tab) h->on_tab(h->ctx, 1);
        return YES;
    }
    if (commandSelector == @selector(insertNewline:) && !h->multiline) {
        if (h->on_submit) h->on_submit(h->ctx);
        return YES;
    }
    return NO;
}

- (BOOL)control:(NSControl *)control textView:(NSTextView *)textView doCommandBySelector:(SEL)commandSelector {
    return [self handleCommandSelector:commandSelector];
}

- (BOOL)textView:(NSTextView *)textView doCommandBySelector:(SEL)commandSelector {
    return [self handleCommandSelector:commandSelector];
}

@end

// ---------------------------------------------------------------------------
// Public C API
// ---------------------------------------------------------------------------

void *native_input_create(void *nsViewPtr, double x, double y, double w, double h, int multiline) {
    @autoreleasepool {
        @try {
            NSView *parent = (__bridge NSView *)nsViewPtr;
            if (parent == nil) return NULL;

            NativeInputHandle *handle = calloc(1, sizeof(NativeInputHandle));
            handle->parent = parent;
            handle->multiline = multiline;
            handle->isProgrammatic = NO;

            NativeInputDelegate *delegate = [[NativeInputDelegate alloc] init];
            delegate.handle = handle;

            if (multiline) {
                double fy = flip_y(handle, y, h);
                NSScrollView *scroll = [[NSScrollView alloc] initWithFrame:NSMakeRect(x, fy, w, h)];
                scroll.hasVerticalScroller = YES;
                scroll.hasHorizontalScroller = NO;
                scroll.borderType = NSNoBorder;
                NSTextView *textView = [[NSTextView alloc] initWithFrame:scroll.contentView.bounds];
                textView.richText = NO;
                textView.horizontallyResizable = NO;
                textView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
                textView.delegate = delegate;
                NSTextContainer *tc = textView.textContainer;
                tc.widthTracksTextView = YES;
                tc.containerSize = NSMakeSize(scroll.contentSize.width, CGFLOAT_MAX);
                scroll.documentView = textView;
                [parent addSubview:scroll];
                handle->control = scroll;
                handle->textView = textView;
            } else {
                double fy = flip_y(handle, y, h);
                NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(x, fy, w, h)];
                field.bezeled = NO;
                field.bordered = NO;
                field.drawsBackground = YES;
                field.editable = YES;
                field.delegate = delegate;
                [parent addSubview:field];
                handle->control = (NSView *)field;
            }

            // Keep the delegate alive for the handle's lifetime (retain).
            objc_setAssociatedObject(handle->control, "nativeInputDelegate", delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

            return handle;
        } @catch (NSException *e) {
            NSLog(@"native_input_create error: %@", e.reason);
            return NULL;
        }
    }
}

void native_input_destroy(void *handlePtr) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            [handle->control removeFromSuperview];
            free(handle);
        } @catch (NSException *e) {
            NSLog(@"native_input_destroy error: %@", e.reason);
        }
    }
}

void native_input_set_value(void *handlePtr, const char *text) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            handle->isProgrammatic = YES;
            NSString *s = [NSString stringWithUTF8String:text != NULL ? text : ""];
            if (handle->multiline) {
                handle->textView.string = s;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                if (field.currentEditor != nil) {
                    // Update the live field editor (KTD6).
                    field.currentEditor.string = s;
                } else {
                    field.stringValue = s;
                }
            }
            handle->isProgrammatic = NO;
        } @catch (NSException *e) {
            NSLog(@"native_input_set_value error: %@", e.reason);
        }
    }
}

const char *native_input_get_value(void *handlePtr) {
    if (handlePtr == NULL) return "";
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            const char *utf8 = NULL;
            if (handle->multiline) {
                utf8 = handle->textView.string.UTF8String;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                if (field.currentEditor != nil) {
                    utf8 = field.currentEditor.string.UTF8String;
                } else {
                    utf8 = field.stringValue.UTF8String;
                }
            }
            set_text_buffer(utf8 != NULL ? utf8 : "");
            return _textBuffer != NULL ? _textBuffer : "";
        } @catch (NSException *e) {
            NSLog(@"native_input_get_value error: %@", e.reason);
            return "";
        }
    }
}

void native_input_set_frame(void *handlePtr, double x, double y, double w, double h) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            handle->control.frame = NSMakeRect(x, flip_y(handle, y, h), w, h);
        } @catch (NSException *e) {
            NSLog(@"native_input_set_frame error: %@", e.reason);
        }
    }
}

void native_input_focus(void *handlePtr) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            if (handle->multiline) {
                [handle->textView.window makeFirstResponder:handle->textView];
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                [field.window makeFirstResponder:field];
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_focus error: %@", e.reason);
        }
    }
}

void native_input_set_font(void *handlePtr, const char *family, double size, double weight) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            NSFont *font = [NSFont systemFontOfSize:size > 0 ? size : 13.0];
            if (family != NULL && strlen(family) > 0) {
                NSFont *named = [NSFont fontWithName:[NSString stringWithUTF8String:family] size:size > 0 ? size : 13.0];
                if (named != nil) font = named;
            }
            if (handle->multiline) {
                handle->textView.font = font;
            } else {
                ((NSTextField *)handle->control).font = font;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_font error: %@", e.reason);
        }
    }
}

void native_input_set_text_color(void *handlePtr, double r, double g, double b, double a) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            NSColor *color = [NSColor colorWithSRGBRed:r green:g blue:b alpha:a];
            if (handle->multiline) {
                handle->textView.textColor = color;
            } else {
                ((NSTextField *)handle->control).textColor = color;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_text_color error: %@", e.reason);
        }
    }
}

void native_input_set_background(void *handlePtr, double r, double g, double b, double a) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            NSColor *color = [NSColor colorWithSRGBRed:r green:g blue:b alpha:a];
            if (handle->multiline) {
                handle->textView.backgroundColor = color;
                handle->textView.drawsBackground = YES;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                field.drawsBackground = YES;
                field.backgroundColor = color;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_background error: %@", e.reason);
        }
    }
}

void native_input_set_placeholder(void *handlePtr, const char *text) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            if (!handle->multiline) {
                NSTextField *field = (NSTextField *)handle->control;
                field.placeholderString = text != NULL ? [NSString stringWithUTF8String:text] : @"";
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_placeholder error: %@", e.reason);
        }
    }
}

void native_input_set_editable(void *handlePtr, int editable, int enabled) {
    if (handlePtr == NULL) return;
    @autoreleasepool {
        @try {
            NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
            if (handle->multiline) {
                handle->textView.editable = editable;
                handle->textView.selectable = editable;
            } else {
                NSTextField *field = (NSTextField *)handle->control;
                field.editable = editable;
                field.selectable = editable;
                field.enabled = enabled;
            }
        } @catch (NSException *e) {
            NSLog(@"native_input_set_editable error: %@", e.reason);
        }
    }
}

void native_input_set_callbacks(void *handlePtr, void *ctx,
                                value_changed_fn valueChanged, committed_fn committed,
                                submit_fn submit, tab_fn tab) {
    if (handlePtr == NULL) return;
    NativeInputHandle *handle = (NativeInputHandle *)handlePtr;
    handle->ctx = ctx;
    handle->on_value_changed = valueChanged;
    handle->on_committed = committed;
    handle->on_submit = submit;
    handle->on_tab = tab;
}
